# Afd_AI: Kế hoạch chuyển đổi từ Base64 Inline sang Authenticated Upload-Then-Reference

**Mục tiêu:** giảm memory amplification trong browser, WebSocket gateway, Node runtime và provider request; giữ backward compatibility trong thời gian chuyển tiếp; không làm suy yếu ownership, quota, private storage hoặc cleanup; tạo nền tảng để nâng điểm Afd_AI từ khoảng **9,1/10 lên 9,5+**.

## 1. Phạm vi và nguyên tắc thiết kế

Hiện tại `message-parts.js` nhận `inline_data`, direct `base64` và `data:image/...;base64,...`, sau đó tạo lại data URL cho OpenAI hoặc inline data cho Gemini. Cách này khiến cùng một ảnh có thể tồn tại đồng thời dưới dạng browser string, WebSocket payload, Node string, Buffer và provider payload. Migration phải thay đổi contract để WebSocket chỉ truyền một attachment reference ngắn, không truyền nội dung nhị phân.

Các nguyên tắc bắt buộc là: mọi upload phải có ticket ngắn hạn và single-use; server không tin MIME type hoặc kích thước do client tự khai báo; file phải được ghi vào private storage qua `AttachmentDiskGuard`; quota phải được reserve trước khi nhận đủ bytes và release khi upload thất bại; reference phải gắn với owner, session/conversation và purpose; provider adapter chỉ được đọc file server-side sau khi authorization thành công; dữ liệu base64 cũ vẫn đọc được trong giai đoạn compatibility nhưng bị giới hạn và có metric để loại bỏ.

## 2. Kiến trúc đích

Luồng mới nên có bốn bước độc lập:

```text
Magento ticket endpoint
        |
        v
POST /rest/V1/afd-ai/attachments/init
        |
        | short-lived upload ticket + attachment_id + max bytes
        v
Authenticated HTTP upload
        |
        v
Private var/afd_ai/chat/... temporary object
        |
        v
POST /rest/V1/afd-ai/attachments/complete
        |
        v
WebSocket message {type: "attachment_ref", attachment_id, ...}
        |
        v
Gateway validates reference -> provider adapter reads private bytes
```

Browser không được tự tạo URL private, không được gửi path filesystem và không được gửi provider-specific inline payload. `attachment_id` nên là opaque random identifier, ví dụ 128-bit hoặc 192-bit random value được encode base64url; không dùng conversation ID tuần tự làm security boundary.

## 3. Phase 0 — Inventory và contract freeze

Trước khi viết implementation, lập bảng contract cho tất cả nơi đang xử lý base64:

| Khu vực | Hiện trạng cần ghi nhận | Contract đích |
|---|---|---|
| Frontend chat composer | Đang giữ File/DataURL và gửi inline payload | Upload trước, chỉ giữ `attachment_id`, status và thumbnail URL tạm thời |
| `message-parts.js` | Tạo `data:` URL cho OpenAI/Gemini | Chỉ nhận server-resolved attachment bytes hoặc provider-safe temporary stream |
| `conversation-history.js` | Có thể tạo preview data URL | Lưu metadata/reference, không lưu base64 trong transcript mới |
| Node gateway WebSocket | Nhận message có image data | Nhận `attachment_ref`, validate ownership/purpose/expiry |
| Magento storage | Đã có private attachment storage và quota guard | Mở rộng thêm temporary state và finalize flow |
| Cleaner/reconciler | Dọn file orphan theo path/message reference | Dọn cả temporary/expired upload theo state và lease |

Trong phase này cần freeze schema của message mới, ví dụ:

```json
{
  "type": "attachment_ref",
  "attachment_id": "opaque-id",
  "kind": "image",
  "purpose": "vision",
  "client_name": "optional-display-name"
}
```

Không cho phép client gửi `path`, `absolute_path`, `storage_key`, `owner_path`, `mime_type` làm authority hoặc `bytes` làm usage authority.

## 4. Phase 1 — Attachment identity và lifecycle

Tạo attachment entity/table hoặc mở rộng bảng hiện có với các trường tối thiểu:

| Trường | Ý nghĩa |
|---|---|
| `attachment_id` | Opaque public identifier, unique và không đoán được |
| `owner_type`, `owner_key` | Customer hoặc guest identity đã canonicalize |
| `conversation_id` | Có thể null ở init, bắt buộc khi attach vào message |
| `session_hash` | Ràng buộc guest upload với session/ticket đã ký |
| `purpose` | `vision`, `message`, hoặc loại được whitelist |
| `state` | `initialized`, `uploading`, `uploaded`, `attached`, `expired`, `deleted`, `failed` |
| `storage_path` | Internal path, không bao giờ trả trực tiếp cho browser |
| `mime_type` | Server-detected MIME |
| `byte_size` | Server-counted bytes |
| `sha256` | Integrity/deduplication/forensics; không dùng thay authorization |
| `created_at`, `expires_at`, `attached_at`, `deleted_at` | TTL và lifecycle audit |
| `reservation_id` | Liên kết với quota reservation |

State transition phải có allow-list:

```text
initialized -> uploading -> uploaded -> attached -> deleted
initialized -> expired -> deleted
uploading -> failed -> deleted
uploaded -> expired -> deleted
```

Không cho phép `attached -> uploaded`, hoặc client tự đổi `owner_key`, `storage_path`, `byte_size`, `state`.

## 5. Phase 2 — Init endpoint và ticket

Thêm Magento service contract, ví dụ `AttachmentUploadManagementInterface::initiate()`. Endpoint init phải:

1. Xác định identity từ Magento session/ticket, không lấy owner từ request body.
2. Kiểm tra enabled flag, ACL/guest policy, conversation ownership nếu conversation đã tồn tại.
3. Kiểm tra purpose và MIME allow-list ở mức declared hint, nhưng vẫn revalidate sau upload.
4. Áp dụng per-identity và network rate limit.
5. Tạo `attachment_id`, `reservation_id`, `expires_at` ngắn, đề xuất 5 phút.
6. Reserve quota theo **maximum declared upload bytes**, không theo con số client có thể sửa sau đó.
7. Trả về upload URL/route, opaque ID, ticket, `max_bytes`, expiry và chunk policy.

Ticket nên chứa hoặc tham chiếu tới:

```text
attachment_id, owner_hash, session_hash, purpose, max_bytes,
allowed_mime_types, issued_at, expires_at, nonce
```

Ticket phải được HMAC ký hoặc lưu server-side theo nonce hash. Claim phải single-use hoặc chuyển state từ `initialized` sang `uploading` atomically.

## 6. Phase 3 — Upload endpoint và streaming validation

Upload endpoint phải nhận `application/octet-stream` hoặc multipart streaming, nhưng không được đọc toàn bộ body vào memory. Quy trình:

1. Verify ticket signature, expiry, nonce, owner/session binding và purpose.
2. Reject nếu `Content-Length` vượt limit; nếu thiếu, vẫn enforce streaming byte counter.
3. Đọc theo fixed-size chunks, ví dụ 64–256 KiB.
4. Abort ngay khi vượt `max_bytes` hoặc global free-space guard.
5. Ghi vào temporary private path có random name, không dùng client filename.
6. Tính SHA-256 trong lúc stream.
7. Detect MIME bằng magic bytes/server library; không tin extension hoặc `Content-Type`.
8. Với image, decode metadata và kiểm tra width, height, total pixels, decompression bomb protection.
9. Chỉ sau khi validation hoàn tất mới chuyển state `uploading -> uploaded`.
10. Nếu bất kỳ bước nào lỗi, xóa temp file và release reservation idempotently.

Không ghi temporary file trực tiếp vào public media hoặc static directory. Response không trả nội dung ảnh và không trả filesystem path.

## 7. Phase 4 — Complete/attach API

Sau khi upload thành công, client gửi `attachment_id` trong message hoặc gọi complete endpoint. Server phải kiểm tra:

- attachment đang ở state `uploaded`;
- ticket/session/owner hiện tại khớp owner đã init;
- chưa quá hạn;
- purpose phù hợp với action;
- byte size, MIME và pixel metadata đã được server xác minh;
- attachment chưa được attach vào conversation khác;
- conversation thuộc đúng customer/guest identity.

Khi message persist thành công, trong transaction database cần ghi reference metadata và chuyển `uploaded -> attached`. `commit()` quota chỉ được thực hiện một lần khi attachment chuyển sang durable/attached. Nếu message persist thất bại, attachment vẫn ở `uploaded` và được cleanup theo TTL, không được giữ vô hạn.

Reference lưu trong message nên là metadata nhỏ:

```json
{
  "storage": "private-v2",
  "attachment_id": "opaque-id",
  "kind": "image",
  "mime_type": "image/webp",
  "bytes": 183421,
  "sha256": "...",
  "conversation_id": 123
}
```

Không lưu base64 trong message mới.

## 8. Phase 5 — Gateway và provider migration

Gateway cần thêm một resolver duy nhất, ví dụ `resolveAttachmentReference()`. Resolver nhận attachment ID, gọi Magento internal signed endpoint hoặc service client, rồi trả về một server-side readable stream/Buffer có giới hạn.

OpenAI và Gemini adapter không nên tự biết contract frontend. `message-parts.js` nên tách thành hai đường:

- **Legacy path:** đọc base64 cũ, giữ hard byte limit, metric và feature flag.
- **Reference path:** validate attachment reference, lấy server-side bytes hoặc provider-compatible URL/token.

Trong giai đoạn đầu, gateway có thể tải attachment một lần vào bounded Buffer vì đã loại bỏ duplication ở WebSocket/browser. Không nên biến reference thành public URL dài hạn. Nếu provider hỗ trợ signed URL private, dùng URL TTL rất ngắn và scope theo provider request; nếu không, dùng bounded stream hoặc Buffer.

Reject các reference bất hợp lệ bằng error code ổn định như `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_EXPIRED`, `ATTACHMENT_NOT_AUTHORIZED`, `ATTACHMENT_PURPOSE_MISMATCH` và `ATTACHMENT_LIMIT_EXCEEDED`. Không trả lý do filesystem chi tiết cho browser.

## 9. Phase 6 — Quota, cleanup và crash recovery

Quota cần chuyển từ reservation chỉ theo owner/total bytes sang reservation có identity:

| Thành phần | Yêu cầu |
|---|---|
| Reservation | Có `reservation_id`, bytes, owner, created/expiry time |
| Init fail | Release reservation ngay trong transaction |
| Upload fail | Xóa temp file rồi release reservation; retry idempotent |
| Process crash | Cron tìm `uploading` quá hạn, xác minh file, release và mark failed/deleted |
| Message persist fail | Giữ `uploaded` theo TTL, không commit durable usage lần hai |
| Duplicate complete | Idempotent theo `attachment_id` và state |
| Manual file deletion | Reconciler sửa `used_bytes`; orphan state vẫn được log |

Cần giữ invariant sau mọi job:

```text
used_bytes >= 0
reserved_bytes >= 0
owner.used_bytes + owner.reserved_bytes <= owner_limit
global.used_bytes + global.reserved_bytes <= global_limit
attached attachment luôn có message reference hợp lệ
```

Reconciler nên bổ sung xử lý reservation expiry, không chỉ sửa `used_bytes`. Khi tạo global row mới, dùng tổng `reserved_bytes` hiện có của owner rows thay vì mặc định 0 để bảo toàn invariant.

Cleaner cần xử lý riêng ba nhóm: expired initialized/uploading, uploaded không được attach sau TTL, và attached files không còn message reference. Enumeration nên bounded theo batch/checkpoint để không gom toàn bộ filesystem vào memory.

## 10. Phase 7 — Frontend migration và backward compatibility

Triển khai theo feature flag, không đổi contract một lần:

| Giai đoạn | Frontend behavior | Gateway behavior |
|---|---|---|
| A | Base64 hiện tại | Giữ legacy path, thêm metric |
| B | Upload-then-reference cho internal/staff hoặc 1% traffic | Accept cả hai |
| C | Bật reference cho customer/guest theo cohort | Reject reference lỗi, legacy vẫn fallback |
| D | Tắt base64 cho message mới | Chỉ giữ legacy đọc lịch sử cũ |
| E | Xóa legacy write path sau retention window | Chỉ resolve `private-v2` |

Browser chỉ giữ `File`, upload progress và metadata nhỏ. Thumbnail preview có thể dùng `URL.createObjectURL(file)` local; không đưa data URL vào message protocol. Khi upload xong, UI hiển thị `attachment_id` và upload state. Nếu upload fail, cho phép retry bằng ticket mới, không reuse ticket đã claim.

Hỗ trợ reconnect phải idempotent: client không tự attach lại một attachment đã ở `attached`; gateway trả state hiện tại.

## 11. Migration dữ liệu cũ

Không cần decode và re-upload toàn bộ base64 lịch sử ngay lập tức. Giữ legacy message payload read-only trong retention window. Khi message cũ được mở:

1. Render bằng adapter legacy hiện tại.
2. Không chuyển base64 vào message mới.
3. Nếu cần reuse ảnh cũ cho action mới, tạo một attachment mới bằng server-side controlled import, kiểm tra lại bytes/MIME/pixels và quota.
4. Gắn reference mới vào action hiện tại.

Sau retention window, chạy migration batch chỉ với các record cần giữ lâu dài. Batch phải có checkpoint, idempotency key, maximum records/run, dry-run và audit log. Không xóa base64 lịch sử trước khi metrics xác nhận không còn consumer legacy.

## 12. Observability và security telemetry

Thêm metrics và structured logs:

- `attachment_init_total{result,purpose}`
- `attachment_upload_total{result,mime}`
- `attachment_upload_bytes_total`
- `attachment_upload_duration_ms`
- `attachment_rejected_total{reason}`
- `attachment_expired_total`
- `attachment_orphan_deleted_total`
- `attachment_quota_reservation_stale_total`
- `attachment_legacy_base64_total`
- `attachment_provider_resolve_total{result}`
- peak Node heap trong upload/provider resolve

Không log base64, raw ticket, session cookie, private path hoặc customer PII. Log chỉ dùng attachment ID hash hoặc truncated ID.

Alert nên đặt cho: upload rejection spike, quota drift khác 0, stale reservation tăng, cleanup backlog, repeated authorization failures, provider resolve latency và Node heap growth.

## 13. Test matrix và quality gates

### Unit tests

Test ticket signature, expiry, nonce reuse, owner mismatch, purpose mismatch, content-length overflow, streaming overflow, MIME sniffing, pixel bomb, reservation rollback, idempotent complete, expired cleanup và provider resolver authorization.

### Integration tests

Dùng MySQL và Redis thật để kiểm tra hai upload song song cùng owner/global quota, duplicate complete, Redis lock contention, rollback sau database exception và cron expiry cleanup.

### Crash/chaos tests

Kill process ở các điểm: sau reservation, giữa chunk 1 và chunk cuối, sau rename nhưng trước DB update, sau DB commit nhưng trước response, và sau message persist nhưng trước quota commit. Sau mỗi lần kill, chạy recovery/reconciliation và kiểm tra toàn bộ invariant.

### Browser/E2E tests

Xác nhận browser không gửi `data:image`, WebSocket frame chỉ chứa reference, retry upload không duplicate file, reconnect không duplicate message, progress hoạt động, guest/customer ownership đúng và legacy history vẫn render.

### Acceptance gates

Migration chỉ được promote khi: memory peak giảm tối thiểu 50% trên cùng workload; không có WebSocket frame chứa base64 trong reference cohort; upload p95 nằm trong SLO đã thống nhất; không có quota invariant violation; stale reservations tự giải phóng; toàn bộ Node/PHP suites pass; DI compile và static/security checks pass.

## 14. Rollout, rollback và mốc thực hiện

| Milestone | Deliverable | Exit criteria |
|---|---|---|
| M1 | Schema, state machine, ticket service, metrics | Unit tests pass; legacy behavior unchanged |
| M2 | Init/upload/complete Magento APIs | Integration tests pass; private path verified |
| M3 | Frontend reference upload behind flag | Browser/E2E confirms no base64 WebSocket frame |
| M4 | Gateway/provider resolver | OpenAI/Gemini contract tests pass |
| M5 | Cleanup/recovery/reconciliation v2 | Crash tests and invariants pass |
| M6 | Canary rollout | Metrics stable for agreed observation window |
| M7 | Default-on reference path | Rollback flag tested and documented |
| M8 | Disable legacy writes | Legacy read-only path retained through retention window |

Rollback phải là feature-flag rollback, không phải database destructive rollback. Khi có sự cố, tắt reference writes, giữ resolver đọc các attachment đã upload, bật lại legacy write path có byte limit, và không xóa temporary files cho tới khi recovery job xử lý xong. Chỉ drop legacy columns/payload sau khi retention, audit và backup đã hoàn tất.

## 15. Tiêu chí để chấm 9,5+

Điểm 9,5+ chỉ nên được công nhận khi đạt đồng thời các điều kiện sau:

1. Browser/WebSocket không còn gửi base64 cho message mới.
2. Upload được streaming và bounded-memory.
3. Tất cả attachment reference đều có ownership, purpose, expiry và single-use authorization phù hợp.
4. Quota reservation có lifecycle/idempotency/expiry và recovery sau process crash.
5. Cleaner/reconciler không có full unbounded batch memory behavior.
6. Có MySQL/Redis integration tests và chaos tests cho partial failure.
7. Legacy path chỉ còn read-only hoặc bị tắt hoàn toàn sau migration window.
8. Có metrics, alert và rollback flag được kiểm chứng trên canary.

Nếu chỉ hoàn thành API upload nhưng vẫn giữ frontend gửi base64 song song không kiểm soát, điểm performance chưa nên tăng đáng kể; giá trị chính chỉ xuất hiện khi reference path trở thành đường mặc định và được chứng minh bằng E2E/telemetry.
