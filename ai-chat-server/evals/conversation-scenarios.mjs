const catalogTopics = [
    { key: 'windbreaker', query: 'áo khoác', title: 'Windbreaker individualisierbar', kind: 'configurable' },
    { key: 'tshirt', query: 'áo thun', title: 'T-Shirt', kind: 'configurable' },
    { key: 'cap', query: 'mũ', title: 'Kappe', kind: 'simple' },
    { key: 'balloons', query: 'Luftballons', title: 'Luftballons', kind: 'simple' },
    { key: 'mug', query: 'Tasse', title: 'Tasse', kind: 'simple' },
    { key: 'banner', query: 'Banner', title: 'Banner', kind: 'configurable' },
    { key: 'flag', query: 'Fahne', title: 'Fahne', kind: 'simple' },
    { key: 'hoodie', query: 'Kapuzenpulli', title: 'Kapuzenpulli', kind: 'configurable' },
    { key: 'flyer', query: 'Faltblatt', title: 'Faltblatt', kind: 'configurable' },
    { key: 'sticker', query: 'Aufkleber', title: 'Aufkleber', kind: 'simple' }
];

const dialects = [
    { key: 'bac', label: 'Bắc', opener: 'Bác ơi, shop mình có', ref: 'mẫu đầu tiên kia', follow: 'Cái đó còn mấy cái vậy?', marker: 'kia' },
    { key: 'hanoi', label: 'Hà Nội', opener: 'Cho em hỏi bên mình có', ref: 'mẫu số một vừa hiện', follow: 'Mẫu ấy còn hàng chứ ạ?', marker: 'ấy' },
    { key: 'hai_phong', label: 'Hải Phòng', opener: 'Bên mình có', ref: 'cái mẫu đầu tiên đấy', follow: 'Cái đấy còn bao nhiêu?', marker: 'đấy' },
    { key: 'hue', label: 'Huế', opener: 'Cho tui hỏi có', ref: 'mẫu đầu tiên ni', follow: 'Cái ni còn mấy cái rứa?', marker: 'ni' },
    { key: 'danang', label: 'Đà Nẵng', opener: 'Cho mình hỏi shop có', ref: 'mẫu đầu tiên nớ', follow: 'Mẫu nớ còn hàng không?', marker: 'nớ' },
    { key: 'quangnam', label: 'Quảng Nam', opener: 'Mi tìm giúp tau', ref: 'mẫu đầu tiên đó', follow: 'Cái đó còn bao nhiêu hỉ?', marker: 'hỉ' },
    { key: 'saigon', label: 'Sài Gòn', opener: 'Shop ơi, có', ref: 'mẫu đầu tiên hồi nãy', follow: 'Mẫu đó còn bao nhiêu cái vậy?', marker: 'hồi nãy' },
    { key: 'cantho', label: 'Cần Thơ', opener: 'Cho mình hỏi có bán', ref: 'mẫu đầu tiên này nè', follow: 'Cái này còn hông?', marker: 'hông' },
    { key: 'taynguyen', label: 'Tây Nguyên', opener: 'Bên mình có', ref: 'mẫu đầu tiên đó nha', follow: 'Mẫu đó còn mấy cái vậy?', marker: 'nha' },
    { key: 'khmer', label: 'Nam Bộ', opener: 'Tui cần tìm', ref: 'cái đầu tiên lúc nãy', follow: 'Cái đó còn hàng hem?', marker: 'hem' }
];

export const conversationScenarios = dialects.flatMap((dialect) => catalogTopics.map((topic) => {
    const id = `commerce-${dialect.key}-${topic.key}`;
    const variantFollowUp = topic.kind === 'configurable'
        ? 'Nếu còn, kiểm tra giúp mình size M. Nếu M có nhiều biến thể thì nói rõ cần chọn thêm gì, đừng cộng số lượng các biến thể.'
        : 'Nếu còn, kiểm tra chính xác số lượng đang bán được của đúng mẫu đó giúp mình.';

    return {
        id,
        title: `${dialect.label}: ${topic.title}`,
        locale: dialect.label,
        dialect_marker: dialect.marker,
        catalog_topic: topic,
        requirements: {
            min_turns: 5,
            requires_catalog_context: true,
            requires_search_tool: true,
            requires_availability_tool: true,
            must_not_request_sku_again: true,
            must_not_invent_stock: true,
            configurable_qty_must_not_be_aggregated: topic.kind === 'configurable'
        },
        turns: [
            {
                role: 'user',
                text: `${dialect.opener} ${topic.query} không? Tìm giúp mình vài lựa chọn phù hợp nhé.`,
                expect: ['search']
            },
            {
                role: 'user',
                text: `Trong các kết quả, ${dialect.ref}${topic.kind === 'configurable' ? ` là ${topic.title}` : ''}. ${dialect.follow}`,
                expect: ['availability', 'memory']
            },
            {
                role: 'user',
                text: variantFollowUp,
                expect: ['availability', 'memory', ...(topic.kind === 'configurable' ? ['variant_safety'] : [])]
            },
            {
                role: 'user',
                text: 'Mình chưa chốt mua đâu. Tóm tắt ngắn tên sản phẩm, lựa chọn đang liên quan và tồn kho vừa kiểm tra; nếu thiếu thông tin thì nói rõ thiếu gì.',
                expect: ['memory', 'grounded_summary']
            },
            {
                role: 'user',
                text: `Nhắc lại giúp mình: đây là ${topic.title} nào và mình đã hỏi gì ở lượt trước?`,
                expect: ['memory', 'natural_language']
            }
        ]
    };
}));

if (conversationScenarios.length !== 100) {
    throw new Error(`Expected 100 conversation scenarios, got ${conversationScenarios.length}.`);
}
