/** attachmentMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.attachmentMethods = function (context) {
        const { config, urls } = context;
        const {
            sanitizeHtml,
            hydrateProductGridHtml,
            getBrowserFormKey,
            resolveWebSocketUrl,
            PET_SPRITESHEET_COLUMNS,
            PET_SPRITESHEET_ROWS,
            PET_FRAME_LIBRARY,
            petFramePosition,
            IMAGE_UPLOAD_MAX_BYTES,
            IMAGE_UPLOAD_MAX_COUNT,
            IMAGE_UPLOAD_MAX_TOTAL_BYTES,
            IMAGE_UPLOAD_MAX_ENCODED_BYTES,
            IMAGE_UPLOAD_MAX_TOTAL_PIXELS,
            IMAGE_UPLOAD_TYPES,
            MAX_MODEL_HISTORY_MESSAGES
        } = context.helpers;

        return {
            /**
             * Codex-style generated-image placeholder.
             *
             * Codex renders a stationary canvas grid and moves two softly
             * illuminated fields through it. Keeping the dots themselves in
             * place avoids the distracting conveyor-belt effect of animating
             * a CSS background-position.
             */
            initGeneratedImageDots(canvas) {
                if (!canvas || canvas.dataset.afdImageDotsReady === 'true') return;
                canvas.dataset.afdImageDotsReady = 'true';

                const host = canvas.parentElement;
                const context2d = canvas.getContext('2d');
                if (!host || !context2d) return;

                const reducedMotion = typeof window.matchMedia === 'function'
                    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                const tau = Math.PI * 2;
                const spacing = 12;
                const radius = 1;
                const clamp = value => Math.min(1, Math.max(0, value));
                const smoothstep = value => {
                    const progress = clamp(value);
                    return progress * progress * (3 - (2 * progress));
                };
                const triangle = value => {
                    const progress = value % 1;
                    return progress <= 0.5 ? progress * 2 : 2 - (progress * 2);
                };
                const easeInOutCubic = value => value < 0.5
                    ? 4 * value * value * value
                    : 1 - (Math.pow(-2 * value + 2, 3) / 2);
                const lerp = (start, end, progress) => start + ((end - start) * progress);
                const random = (start, end) => start + (Math.random() * (end - start));
                const duration = milliseconds => milliseconds * 1.2 * random(1, 1.35);
                const field = {
                    duration: {
                        x1: duration(4500),
                        y1: duration(6330),
                        x2: duration(5600),
                        y2: duration(5750),
                        size1: duration(3600),
                        size2: duration(2400)
                    },
                    phase: {
                        x1: Math.random(),
                        y1: Math.random(),
                        x2: Math.random(),
                        y2: Math.random(),
                        size1: Math.random(),
                        size2: Math.random()
                    },
                    bounds: {
                        x1Start: random(0.1, 0.32),
                        x1End: random(0.68, 0.9),
                        y1Start: random(0.1, 0.32),
                        y1End: random(0.68, 0.9),
                        x2Start: random(0.68, 0.9),
                        x2End: random(0.1, 0.32),
                        y2Start: random(0.68, 0.9),
                        y2End: random(0.1, 0.32)
                    },
                    size: {
                        firstStart: random(0.42, 0.52),
                        firstEnd: random(0.62, 0.75),
                        secondStart: random(0.5, 0.62),
                        secondEnd: random(0.74, 0.9)
                    }
                };
                let layout = null;
                let frame = null;
                let startedAt = null;
                let needsLayout = true;

                const rebuildLayout = () => {
                    const rect = host.getBoundingClientRect();
                    const width = Math.max(0, Math.floor(rect.width));
                    const height = Math.max(0, Math.floor(rect.height));
                    if (!width || !height) {
                        layout = null;
                        return;
                    }

                    const dpr = Math.max(1, window.devicePixelRatio || 1);
                    const pixelWidth = Math.floor(width * dpr);
                    const pixelHeight = Math.floor(height * dpr);
                    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
                        canvas.width = pixelWidth;
                        canvas.height = pixelHeight;
                    }

                    const columns = Math.max(1, Math.floor(width / spacing));
                    const rows = Math.max(1, Math.floor(height / spacing));
                    const offsetX = (width - ((columns - 1) * spacing)) * 0.5;
                    const offsetY = (height - ((rows - 1) * spacing)) * 0.5;
                    layout = { width, height, dpr, columns, rows, offsetX, offsetY };
                    needsLayout = false;
                };

                const render = timestamp => {
                    if (!canvas.isConnected) {
                        resizeObserver.disconnect();
                        themeObserver?.disconnect();
                        return;
                    }
                    if (startedAt === null) startedAt = timestamp;
                    if (needsLayout || !layout) rebuildLayout();
                    if (!layout) {
                        frame = window.requestAnimationFrame(render);
                        return;
                    }

                    const elapsed = reducedMotion ? 0 : timestamp - startedAt;
                    const cycle = (key, easing) => easing(triangle(
                        (elapsed / field.duration[key]) + field.phase[key]
                    ));
                    const x1 = lerp(field.bounds.x1Start, field.bounds.x1End, cycle('x1', easeInOutCubic));
                    const y1 = lerp(field.bounds.y1Start, field.bounds.y1End, cycle('y1', smoothstep));
                    const x2 = lerp(field.bounds.x2Start, field.bounds.x2End, cycle('x2', easeInOutCubic));
                    const y2 = lerp(field.bounds.y2Start, field.bounds.y2End, cycle('y2', smoothstep));
                    const size1 = 0.78 * lerp(field.size.firstStart, field.size.firstEnd, cycle('size1', smoothstep));
                    const size2 = 0.78 * lerp(field.size.secondStart, field.size.secondEnd, cycle('size2', smoothstep));
                    const style = window.getComputedStyle(host);
                    const accent = style.getPropertyValue('--afd-chat-accent-live').trim() || '#c32654';

                    context2d.save();
                    context2d.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
                    context2d.clearRect(0, 0, layout.width, layout.height);
                    context2d.fillStyle = accent;

                    for (let row = 0; row < layout.rows; row += 1) {
                        const y = layout.offsetY + (row * spacing);
                        const normalizedY = layout.rows === 1 ? 0.5 : row / (layout.rows - 1);
                        for (let column = 0; column < layout.columns; column += 1) {
                            const x = layout.offsetX + (column * spacing);
                            const normalizedX = layout.columns === 1 ? 0.5 : column / (layout.columns - 1);
                            const distance1 = Math.hypot(normalizedX - x1, normalizedY - y1);
                            const distance2 = Math.hypot(normalizedX - x2, normalizedY - y2);
                            const light1 = 1 - smoothstep(distance1 / size1);
                            const light2 = 1 - smoothstep(distance2 / size2);
                            const alpha = clamp(Math.pow((light1 * 1.2) + (light2 * 0.82), 1.18));
                            // A faint floor keeps the grid visible across the
                            // full image frame while the Codex fields travel.
                            context2d.globalAlpha = Math.max(0.075, alpha);
                            context2d.beginPath();
                            context2d.arc(x, y, radius, 0, tau);
                            context2d.fill();
                        }
                    }
                    context2d.restore();

                    if (!reducedMotion) frame = window.requestAnimationFrame(render);
                };

                const resizeObserver = new ResizeObserver(() => {
                    needsLayout = true;
                    if (reducedMotion) frame = window.requestAnimationFrame(render);
                });
                const chatRoot = host.closest('.afd-ai-chat');
                const themeObserver = chatRoot && typeof MutationObserver === 'function'
                    ? new MutationObserver(() => {
                        if (reducedMotion) frame = window.requestAnimationFrame(render);
                    })
                    : null;

                resizeObserver.observe(host);
                themeObserver?.observe(chatRoot, { attributes: true, attributeFilter: ['style', 'data-ui-theme'] });
                frame = window.requestAnimationFrame(render);
            },

            openImagePicker() {
                if (!this.canUploadImages || this.isReadingAttachments || !this.$refs.imageInput) return;
                this.$refs.imageInput.click();
            },

            handleImageFileChange(event) {
                const files = event.target.files ? Array.from(event.target.files) : [];
                event.target.value = '';
                this.handleImageAttachmentFiles(files);
            },

            handleComposerPaste(event) {
                if (!this.canUploadImages || this.isReadingAttachments) return;
                const clipboard = event.clipboardData;
                if (!clipboard) return;

                const files = this.extractClipboardImageFiles(clipboard);
                if (!files.length) return;

                event.preventDefault();
                this.handleImageAttachmentFiles(files);
            },

            handleComposerDrop(event) {
                if (!this.canUploadImages || this.isReadingAttachments) return;
                const transfer = event.dataTransfer;
                if (!transfer) return;

                const files = this.extractClipboardImageFiles(transfer);
                if (!files.length) return;

                this.handleImageAttachmentFiles(files);
            },

            handleComposerKeydown(event) {
                if (this.isLoading || !event) return;
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;

                event.preventDefault();
                this.sendMessage();
            },

            extractClipboardImageFiles(source) {
                const items = source && source.items ? Array.from(source.items) : [];
                const itemFiles = items
                    .filter(item => item.kind === 'file' && IMAGE_UPLOAD_TYPES.includes(item.type))
                    .map(item => item.getAsFile())
                    .filter(Boolean);
                if (itemFiles.length) return itemFiles;

                const files = source && source.files ? Array.from(source.files) : [];
                return files.filter(file => IMAGE_UPLOAD_TYPES.includes(file.type));
            },

            resizeComposerInput() {
                const input = this.$refs.composerInput;
                if (!input) return;

                // Read the element value rather than Alpine state: on paste and the
                // first input event, x-model may update after this handler runs.
                if (!String(input.value || '').trim()) {
                    this.resetComposerInput();
                    return;
                }

                const styles = window.getComputedStyle(input);
                const computedMaxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight);
                const maxHeight = Number.isFinite(computedMaxHeight) ? computedMaxHeight : 208;
                const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
                const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
                const singleLineHeight = Math.ceil(lineHeight + verticalPadding);
                input.style.height = 'auto';
                const contentHeight = input.scrollHeight;
                // Expanding changes the editor from the narrow one-line grid to a
                // full-width input above the action row. That extra width can make
                // the same text fit on one line again, so recalculating this flag
                // on every keystroke would make the composer flip between layouts.
                // Treat expansion as a drafting mode: enter it when the first wrap
                // occurs and keep it until the author clears the message entirely.
                if (!this.isComposerExpanded && contentHeight > singleLineHeight + 2) {
                    this.isComposerExpanded = true;
                    // The expanded layout gives the textarea the full row width.
                    // Re-measure after Alpine has applied that layout so its height
                    // immediately matches the wider input instead of leaving the
                    // height calculated for the old, narrower grid.
                    this.$nextTick(() => this.resizeComposerInput());
                }
                const nextHeight = Math.max(36, Math.min(contentHeight, maxHeight));
                input.style.height = nextHeight + 'px';
                input.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
            },

            resetComposerInput() {
                const input = this.$refs.composerInput;
                if (!input) return;

                this.isComposerExpanded = false;
                input.style.height = '';
                input.style.overflowY = 'hidden';
            },

            getEditMessageInput() {
                const input = this.$refs.editComposerInput;
                if (Array.isArray(input)) return input[0] || null;
                return input || null;
            },

            resizeEditMessageInput() {
                const input = this.getEditMessageInput();
                if (!input) return;

                const maxHeight = 260;
                input.style.height = 'auto';
                const nextHeight = Math.max(92, Math.min(input.scrollHeight, maxHeight));
                input.style.height = nextHeight + 'px';
                input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
            },

            async handleImageAttachmentFiles(files) {
                const sourceFiles = Array.isArray(files) ? files : [];
                if (!sourceFiles.length) return;

                const availableSlots = IMAGE_UPLOAD_MAX_COUNT - this.imageAttachments.length;
                if (availableSlots <= 0) {
                    this.uploadError = `You can attach up to ${IMAGE_UPLOAD_MAX_COUNT} images to one message.`;
                    return;
                }

                const validFiles = [];
                let selectedBytes = this.imageAttachments.reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0);
                for (const file of sourceFiles.slice(0, availableSlots)) {
                    if (!IMAGE_UPLOAD_TYPES.includes(file.type)) {
                        this.uploadError = 'Only JPG, PNG, or WebP images are supported.';
                        continue;
                    }
                    if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
                        this.uploadError = 'Each image must be 4MB or smaller.';
                        continue;
                    }
                    if (selectedBytes + file.size > IMAGE_UPLOAD_MAX_TOTAL_BYTES) {
                        this.uploadError = 'The combined image upload is too large. Choose fewer or smaller images.';
                        continue;
                    }
                    selectedBytes += file.size;
                    validFiles.push(file);
                }

                if (sourceFiles.length > availableSlots) {
                    this.uploadError = `Only the first ${availableSlots} image(s) were added. A message supports ${IMAGE_UPLOAD_MAX_COUNT} images.`;
                }
                if (!validFiles.length) return;

                this.isReadingAttachments = true;
                const attachments = [];
                for (const file of validFiles) {
                    const attachment = await this.readImageAttachmentFile(file);
                    if (attachment) attachments.push(attachment);
                }
                this.isReadingAttachments = false;
                if (!attachments.length) {
                    this.uploadError = 'Could not read the selected image(s).';
                    return;
                }

                this.imageAttachments = [...this.imageAttachments, ...attachments];
                if (sourceFiles.length <= availableSlots) this.uploadError = '';
            },

            readImageAttachmentFile(file) {
                return new Promise(resolve => {
                    const objectUrl = typeof URL !== 'undefined'
                        && typeof URL.createObjectURL === 'function'
                        ? URL.createObjectURL(file)
                        : '';
                    if (!objectUrl) {
                        const reader = new FileReader();
                        reader.onload = async () => {
                            const dataUrl = String(reader.result || '');
                            const dimensions = await this.readImageDimensions(dataUrl);
                            if (!dimensions || dimensions.width * dimensions.height > IMAGE_UPLOAD_MAX_TOTAL_PIXELS) {
                                this.uploadError = 'Image dimensions are too large.';
                                resolve(null);
                                return;
                            }
                            resolve({
                                name: this.cleanFileName(file.name),
                                type: file.type,
                                size: file.size,
                                previewUrl: dataUrl,
                                file,
                                width: dimensions.width,
                                height: dimensions.height
                            });
                        };
                        reader.onerror = () => resolve(null);
                        reader.readAsDataURL(file);
                        return;
                    }

                    this.readImageDimensions(objectUrl).then(dimensions => {
                        if (!dimensions || dimensions.width * dimensions.height > IMAGE_UPLOAD_MAX_TOTAL_PIXELS) {
                            this.uploadError = 'Image dimensions are too large.';
                            this.revokeAttachmentPreview({ previewUrl: objectUrl });
                            resolve(null);
                            return;
                        }
                        resolve({
                            name: this.cleanFileName(file.name),
                            type: file.type,
                            size: file.size,
                            previewUrl: objectUrl,
                            file,
                            width: dimensions.width,
                            height: dimensions.height
                        });
                    }).catch(() => resolve(null));
                });
            },

            readImageDimensions(dataUrl) {
                return new Promise(resolve => {
                    const image = new Image();
                    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
                    image.onerror = () => resolve(null);
                    image.src = dataUrl;
                });
            },

            validateOutgoingAttachmentBudget(attachments = []) {
                const totalBytes = attachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
                const totalPixels = attachments.reduce(
                    (sum, item) => sum + ((Number(item.width) || 0) * (Number(item.height) || 0)),
                    0
                );
                if (totalBytes > IMAGE_UPLOAD_MAX_TOTAL_BYTES
                    || totalPixels > IMAGE_UPLOAD_MAX_TOTAL_PIXELS) {
                    this.uploadError = 'The combined image upload is too large. Remove an image or choose smaller files.';
                    return false;
                }
                return true;
            },

            cleanFileName(name) {
                return String(name || 'product-image')
                    .replace(/[^\w.\- ]+/g, '')
                    .trim()
                    .slice(0, 80) || 'product-image';
            },

            removeImageAttachment(index = null) {
                if (Number.isInteger(index)) {
                    const removed = this.imageAttachments[index];
                    this.revokeAttachmentPreview(removed);
                    this.imageAttachments = this.imageAttachments.filter((attachment, attachmentIndex) => attachmentIndex !== index);
                } else {
                    this.imageAttachments.forEach(attachment => this.revokeAttachmentPreview(attachment));
                    this.imageAttachments = [];
                }
                this.uploadError = '';
            },

            revokeAttachmentPreview(attachment) {
                const previewUrl = String(attachment?.previewUrl || '');
                if (!previewUrl.startsWith('blob:') || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
                    return;
                }
                try {
                    URL.revokeObjectURL(previewUrl);
                } catch (error) { }
            },

            formatFileSize(bytes) {
                if (!Number.isFinite(bytes)) return '';
                if (bytes < 1024) return bytes + ' B';
                if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
                return (bytes / 1024 / 1024).toFixed(1) + ' MB';
            },

            async uploadAttachment(attachment) {
                if (attachment.attachment_id) {
                    return {
                        type: 'attachment_ref',
                        attachment_id: attachment.attachment_id,
                        kind: 'image',
                        purpose: 'vision'
                    };
                }

                if (!attachment.file) {
                    return null;
                }

                try {
                    // Step 1: Initiate upload session and acquire ticket
                    const initResponse = await fetch('/rest/V1/afd-ai/attachments/init', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({
                            purpose: 'vision',
                            declaredBytes: attachment.size,
                            declaredMimeType: attachment.type
                        })
                    });

                    if (!initResponse.ok) {
                        return null;
                    }

                    const initData = await initResponse.json();
                    const ticket = initData.ticket;
                    const uploadUrl = initData.upload_url;
                    const attachmentId = initData.attachment_id;

                    // Step 2: Stream binary file to upload endpoint
                    const uploadResponse = await fetch(uploadUrl, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${ticket}`,
                            'Content-Type': attachment.type
                        },
                        body: attachment.file
                    });

                    if (!uploadResponse.ok) {
                        return null;
                    }

                    // Step 3: Complete upload
                    const completeResponse = await fetch('/rest/V1/afd-ai/attachments/complete', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({
                            attachmentId,
                            ticket
                        })
                    });

                    if (!completeResponse.ok) {
                        return null;
                    }

                    attachment.attachment_id = attachmentId;
                    return {
                        type: 'attachment_ref',
                        attachment_id: attachmentId,
                        kind: 'image',
                        purpose: 'vision'
                    };
                } catch (error) {
                    console.warn('[AFD-AI-CHAT] Attachment upload error:', error);
                    return null;
                }
            },

            async prepareOutgoingUserParts(text, attachments = []) {
                const parts = [];
                const cleanText = (text || '').trim();
                parts.push({ text: cleanText || 'Mô tả nội dung hình ảnh này và nếu phù hợp hãy tìm sản phẩm tương ứng trong cửa hàng.' });

                for (const attachment of attachments) {
                    const uploadedRef = await this.uploadAttachment(attachment);
                    if (uploadedRef) {
                        parts.push(uploadedRef);
                    } else if (attachment.attachment_id) {
                        parts.push({
                            type: 'attachment_ref',
                            attachment_id: attachment.attachment_id,
                            kind: 'image',
                            purpose: 'vision'
                        });
                    } else {
                        this.uploadError = 'Upload attachment failed. Please try sending the image again.';
                        throw new Error('Attachment upload failed');
                    }
                }
                return parts;
            },

            buildOutgoingUserParts(text, attachments = []) {
                const parts = [];
                const cleanText = (text || '').trim();
                parts.push({ text: cleanText || 'Mô tả nội dung hình ảnh này và nếu phù hợp hãy tìm sản phẩm tương ứng trong cửa hàng.' });
                attachments.forEach((attachment) => {
                    if (attachment.attachment_id) {
                        parts.push({
                            type: 'attachment_ref',
                            attachment_id: attachment.attachment_id,
                            kind: 'image',
                            purpose: 'vision'
                        });
                    } else if (attachment.base64) {
                        parts.push({
                            inline_data: {
                                mime_type: attachment.type,
                                data: attachment.base64
                            }
                        });
                    }
                });
                return parts;
            },

            buildModelHistory() {
                const mapped = this.messages
                    .slice(0, -1)
                    .filter(m => m.role === 'assistant' || m.role === 'user')
                    .map(m => {
                        if (m.role === 'assistant') {
                            const assistantText = m.parts
                                ? m.parts
                                    .filter(p => p.type === 'text')
                                    .map(p => p.raw || this.htmlToText(p.html || ''))
                                    .filter(Boolean)
                                    .join('\n\n')
                                : '';
                            const catalogProducts = m.parts
                                ? m.parts
                                    .filter(p => p.type === 'products' && p.payload && Array.isArray(p.payload.items))
                                    .flatMap(p => p.payload.items.map((item, index) => {
                                        if (!item || !item.sku || !item.name) return null;
                                        const options = Array.isArray(item.variant_options)
                                            ? item.variant_options
                                                .map((option) => {
                                                    const code = String(option?.code || '').trim();
                                                    const label = String(option?.label || option?.code || '').trim();
                                                    const values = Array.isArray(option?.values)
                                                        ? option.values.map(value => String(value || '').trim()).filter(Boolean)
                                                        : [];
                                                    return code && values.length ? { code, label, values } : null;
                                                })
                                                .filter(Boolean)
                                            : [];
                                        return {
                                            position: index + 1,
                                            product_ref: item.product_ref || (item.id ? `product:${item.id}` : ''),
                                            sku: String(item.sku),
                                            name: String(item.name),
                                            price: String(item.price || ''),
                                            product_type: String(item.product_type || 'simple'),
                                            requires_variant_selection: item.requires_variant_selection === true,
                                            variant_options: options
                                        };
                                    }))
                                    .filter(Boolean)
                                : [];
                            const catalogMemoryEnabled = config.features?.candidate_memory_enabled !== false;
                            const catalogContext = catalogMemoryEnabled && catalogProducts.length
                                ? `[CATALOG_CONTEXT:v2]\n${JSON.stringify({
                                    instruction: 'Resolve unambiguous product references by product_ref or SKU. Check live stock with getProductAvailability before making an availability claim.',
                                    products: catalogProducts
                                })}`
                                : '';
                            const fullText = [
                                assistantText.trim(),
                                m.interrupted === true
                                    ? '[The shopper stopped this response. Continue it only when the next shopper message explicitly asks to continue; otherwise answer the new request normally.]'
                                    : '',
                                catalogContext
                            ].filter(Boolean).join('\n\n');
                            return fullText
                                ? { role: 'model', parts: [{ text: fullText }] }
                                : null;
                        }

                        const userText = (m.content || '').trim();
                        return userText ? { role: 'user', parts: [{ text: userText }] } : null;
                    })
                    .filter(Boolean);

                return mapped.slice(-MAX_MODEL_HISTORY_MESSAGES);
            },

            buildGuestHistorySnapshot() {
                return this.messages
                    .slice(0, -1)
                    .filter(message => message?.role === 'assistant' || message?.role === 'user')
                    .map((message) => {
                        if (message.role === 'user') {
                            const content = String(message.content || '').trim();
                            return content ? { role: 'user', content } : null;
                        }

                        const parts = (Array.isArray(message.parts) ? message.parts : [])
                            .map((part) => {
                                if (part?.type === 'image' && /^https?:\/\//i.test(String(part.url || ''))) {
                                    return {
                                        type: 'image',
                                        url: String(part.url),
                                        alt: String(part.alt || 'Generated image').slice(0, 400),
                                        prompt: String(part.prompt || '').slice(0, 4000),
                                        size: String(part.size || '').slice(0, 32),
                                        quality: String(part.quality || '').slice(0, 16)
                                    };
                                }

                                if (part?.type === 'guest_order_access') {
                                    return {
                                        type: 'guest_order_access',
                                        state: 'email',
                                        purpose: part?.purpose === 'support' ? 'support' : 'order',
                                        expires_at: Math.max(0, Number(part.expiresAt) || 0)
                                    };
                                }

                                if (part?.type === 'order_address_form') {
                                    return {
                                        type: 'order_address_form',
                                        resource_type: part.resourceType === 'customer_account' ? 'customer_account' : 'order',
                                        form_id: String(part.id || ''),
                                        action_token: String(part.actionToken || ''),
                                        created_at: Math.max(0, Number(part.createdAt) || 0),
                                        expires_at: Math.max(0, Number(part.expiresAt) || 0),
                                        access_scope: part.accessScope === 'customer' ? 'customer' : 'guest',
                                        order_number: String(part.orderNumber || ''),
                                        address_types: Array.isArray(part.addressTypes) ? part.addressTypes : [],
                                        address_type: String(part.addressType || ''),
                                        addresses: part.addresses && typeof part.addresses === 'object'
                                            ? Object.entries(part.addresses).reduce((addresses, [type, address]) => {
                                                if (!address || typeof address !== 'object') return addresses;
                                                const { email, ...safeAddress } = address;
                                                addresses[type] = safeAddress;
                                                return addresses;
                                            }, {})
                                            : {},
                                        fields: Array.isArray(part.fields) ? part.fields : [],
                                        countries: Array.isArray(part.countries) ? part.countries.map(country => ({
                                            value: country.value,
                                            label: country.label,
                                            is_region_required: country.isRegionRequired === true,
                                            is_zip_required: country.isZipRequired !== false
                                        })) : [],
                                        regions: part.regions && typeof part.regions === 'object' ? part.regions : {}
                                    };
                                }

                                const raw = String(part?.raw || this.htmlToText(part?.html || '') || '').trim();
                                return raw ? { type: 'text', raw } : null;
                            })
                            .filter(Boolean);

                        if (parts.length === 0) {
                            const raw = String(message.content || '').trim();
                            return raw ? { role: 'assistant', parts: [{ type: 'text', raw }] } : null;
                        }

                        return { role: 'assistant', parts };
                    })
                    .filter(Boolean)
                    .slice(-MAX_MODEL_HISTORY_MESSAGES);
            },

            normalizeStatusMessage(content) {
                const raw = String(content || '').trim();
                if (!raw) return '';

                const lower = raw.toLowerCase();
                if ((lower.includes('search') && lower.includes('product'))
                    || lower.includes('searchproducts')
                    || lower.includes('tìm sản phẩm')
                    || lower.includes('tìm kiếm sản phẩm')) {
                    return 'Searching the product catalog';
                }
                if (lower.includes('listcategories') || lower.includes('danh mục') || lower.includes('category')) {
                    return 'Checking product categories';
                }
                if (lower.includes('addtocart') || lower.includes('cart') || lower.includes('giỏ hàng')) {
                    return 'Updating your cart';
                }
                if (lower.includes('order') || lower.includes('đơn hàng')) {
                    return 'Checking your order details';
                }
                if (lower.includes('address') || lower.includes('địa chỉ')) {
                    return 'Checking your saved addresses';
                }
                if (lower.includes('coupon') || lower.includes('mã giảm giá')) {
                    return 'Checking available offers';
                }
                return 'Working on your request';
            },

            activityIcon() {
                const status = String(this.statusMessage || '').toLowerCase();
                if (status.includes('catalog') || status.includes('categories')) return 'search';
                if (status.includes('cart')) return 'shopping_bag';
                if (status.includes('order')) return 'receipt_long';
                if (status.includes('address')) return 'location_on';
                if (status.includes('offer')) return 'sell';
                return 'more_horiz';
            },

            toolActivityLabel(activity) {
                const tool = String(activity?.tool || '');
                const state = String(activity?.state || 'running');
                const count = Number(activity?.result_count);
                const hasCount = Number.isFinite(count) && count >= 0;

                if (tool === 'searchProducts') {
                    if (state === 'running') return 'Checking products';
                    return state === 'failed' ? 'Product check unavailable' : (hasCount ? `Products checked (${count})` : 'Products checked');
                }
                if (tool === 'searchWeb') {
                    return state === 'running' ? 'Checking external information' : 'External information checked';
                }
                if (tool === 'searchStoreKnowledge') {
                    return state === 'running' ? 'Checking store information' : 'Store information checked';
                }
                if (tool === 'listCategories') {
                    return state === 'running' ? 'Checking categories' : 'Categories checked';
                }
                if (tool === 'getProductAvailability') {
                    return state === 'running' ? 'Checking availability' : 'Availability checked';
                }
                if (tool === 'compareProducts') {
                    return state === 'running' ? 'Comparing selected products' : 'Product comparison checked';
                }
                if (tool === 'addToCart') {
                    return state === 'running' ? 'Updating the cart' : 'Cart update checked';
                }
                if (tool === 'removeFromCart') {
                    return state === 'running' ? 'Updating the cart' : 'Cart update checked';
                }
                if (tool === 'getRecentOrders' || tool === 'getGuestOrders') {
                    return state === 'running' ? 'Checking orders' : 'Orders checked';
                }
                if (tool === 'getOrderDetails' || tool === 'getGuestOrderDetails') {
                    return state === 'running' ? 'Checking order details' : 'Order details checked';
                }
                if (tool === 'getOrderFulfillment') {
                    return state === 'running' ? 'Checking delivery details' : 'Delivery details checked';
                }
                if (tool === 'cancelOrder') {
                    return state === 'running' ? 'Checking the order request' : 'Order request checked';
                }
                if (tool === 'requestReturn') {
                    return state === 'running' ? 'Preparing the return request' : 'Return request checked';
                }
                if (tool === 'handoffToHuman') {
                    return state === 'running' ? 'Contacting support' : 'Support request checked';
                }
                if (tool === 'subscribeBackInStock') {
                    return state === 'running' ? 'Preparing the notification' : 'Notification request checked';
                }
                if (tool === 'updateOrderAddress' || tool === 'updateGuestOrderAddress') {
                    return state === 'running' ? 'Checking the address request' : 'Address request checked';
                }
                if (tool === 'getCustomerAddresses') {
                    return state === 'running' ? 'Checking account addresses' : 'Account address request checked';
                }
                if (tool === 'updateCustomerAddress') {
                    return state === 'running' ? 'Checking account addresses' : 'Account address request checked';
                }
                if (tool === 'generateImage') {
                    return state === 'running' ? 'Preparing the image' : 'Image request checked';
                }
                return state === 'running' ? 'Checking your request' : 'Request checked';
            },

            toolActivityIcon(activity) {
                const tool = String(activity?.tool || '');
                if (tool === 'searchWeb') return 'travel_explore';
                if (tool === 'searchStoreKnowledge') return 'menu_book';
                if (tool === 'searchProducts' || tool === 'listCategories') return 'search';
                if (tool === 'getProductAvailability') return 'inventory_2';
                if (tool === 'compareProducts') return 'compare_arrows';
                if (tool === 'addToCart') return 'shopping_bag';
                if (tool === 'removeFromCart') return 'remove_shopping_cart';
                if (tool === 'getRecentOrders' || tool === 'getGuestOrders' || tool === 'getOrderDetails' || tool === 'getGuestOrderDetails') return 'receipt_long';
                if (tool === 'getOrderFulfillment') return 'local_shipping';
                if (tool === 'cancelOrder') return 'cancel';
                if (tool === 'requestReturn') return 'assignment_return';
                if (tool === 'handoffToHuman') return 'support_agent';
                if (tool === 'subscribeBackInStock') return 'notifications_active';
                if (tool === 'updateOrderAddress' || tool === 'updateGuestOrderAddress') return 'location_on';
                if (tool === 'getCustomerAddresses' || tool === 'updateCustomerAddress') return 'contact_mail';
                if (tool === 'generateImage') return 'auto_awesome';
                return 'more_horiz';
            },

            imageGenerationLabel(part) {
                const startedAt = Number(part?.startedAt || this.responseStartedAt || Date.now());
                const elapsed = Math.max(0, Math.floor((Number(this.imageGenerationNow) - startedAt) / 1000));
                return elapsed > 0 ? `Working for ${elapsed}s` : 'Generating image';
            },

        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
