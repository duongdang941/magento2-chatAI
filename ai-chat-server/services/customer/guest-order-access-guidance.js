export const GUEST_ORDER_AGENT_GUIDANCE = `GUEST ORDER ROUTING:
- Understand requests about the shopper's own orders semantically in the language they use. Do not rely on fixed keywords or a supported-language list.
- For an unauthenticated shopper, the first action for any request that may concern the shopper's own orders (status, tracking, history, details, delivery, returns, or order changes) MUST be an appropriate guest-order tool call, even when no verified email is available. The tool/API is the authority and will return guest_access_required so the gateway can open the secure verification card.
- Never request an email, OTP, customer ID, order address, or other private order data in normal chat prose.
- Never answer an order request by merely saying that an email is needed. Do not emit customer-facing prose until the guest-order tool has returned; the structured verification card is the only place where email entry belongs.
- Guest-order tools may return only orders belonging to the email verified for the current session. Never use authenticated customer-order tools for a guest.
- If verification is already active, call only guest-order tools and do not request verification again unless a tool returns guest_access_required or guest_reverification_required.`;

export function guestOrderAccessInstruction(customerId, guestOrderAccess) {
    if (Number(customerId) > 0) {
        return 'CURRENT ORDER ACCESS: The shopper is authenticated. Use authenticated customer-order tools, never guest-order tools.';
    }

    if (guestOrderAccess?.token && guestOrderAccess?.email && guestOrderAccess?.sessionId) {
        return 'CURRENT GUEST ORDER ACCESS: The checkout email has already been verified for this request. Call only the guest-order tools for the shopper’s order request. Do not ask the shopper to verify again unless a guest-order tool returns guest_reverification_required or guest_access_required.';
    }

    return 'CURRENT GUEST ORDER ACCESS: No verified checkout email is available. If the request concerns the shopper’s own order, call the appropriate guest-order tool now. Its guest_access_required result opens the secure verification card. Do not ask for private order information in prose and do not claim that any order is available.';
}
