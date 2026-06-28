const http = require('http');

// Strict Max Payload Size Limit: 50 Kilobytes to prevent memory flood vectors
const MAX_PAYLOAD_SIZE = 50 * 1024;

// Flexible Multi-Industry Schema Layout
const createCanonicalLead = () => ({
    firstName: "",
    lastName: "",
    cleanPhone: "",
    email: "",
    postalCode: "",
    industryContext: "general",
    source: "generic_api_gateway"
});

// Helper: Fast In-Memory data cleaning algorithms
function cleanPhoneNumber(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') return "";
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
}

function extractName(payload) {
    let first = "";
    let last = "";

    const firstKeys = ['first', 'firstName', 'first_name', 'given_name', 'client_name'];
    const lastKeys = ['last', 'lastName', 'last_name', 'surname'];
    const fullKeys = ['name', 'fullName', 'full_name', 'customer_name', 'buyer_name'];

    for (const key of firstKeys) {
        if (payload[key] && typeof payload[key] === 'string') { first = payload[key].trim(); break; }
    }
    for (const key of lastKeys) {
        if (payload[key] && typeof payload[key] === 'string') { last = payload[key].trim(); break; }
    }

    if (!first && !last) {
        for (const key of fullKeys) {
            if (payload[key] && typeof payload[key] === 'string') {
                const parts = payload[key].trim().split(/\s+/);
                first = parts[0] || "";
                last = parts.slice(1).join(" ") || "";
                break;
            }
        }
    }
    return { firstName: first, lastName: last };
}

function extractEmail(payload) {
    const emailKeys = ['email', 'emailAddress', 'email_address', 'mail', 'buyer_email'];
    for (const key of emailKeys) {
        if (payload[key] && typeof payload[key] === 'string') return payload[key].trim().toLowerCase();
    }
    return "";
}

function extractPostal(payload) {
    const zipKeys = ['zip', 'zipcode', 'zip_code', 'postal', 'postalCode', 'postal_code', 'shipping_zip'];
    for (const key of zipKeys) {
        if (payload[key]) return String(payload[key]).trim().toUpperCase().replace(/\s/g, '');
    }
    return "";
}

function detectContext(payload) {
    if (payload.zillow_property_id || payload.LeadType || payload.mls_id) return { industry: "real_estate", source: "zillow" };
    if (payload.shopify_order_id || payload.sku || payload.item_id) return { industry: "ecommerce", source: "storefront_webhook" };
    if (payload.case_id || payload.matter_number || payload.legal_injury) return { industry: "legal_tech", source: "intake_form" };
    if (payload.ad_id || payload.form_id) return { industry: "marketing", source: "facebook_ads" };
    return { industry: "general", source: "api_gateway" };
}

// Processing Core Engine
function processIncomingWebhook(rawPayload) {
    const target = createCanonicalLead();
    if (!rawPayload || typeof rawPayload !== 'object') return target;

    const names = extractName(rawPayload);
    target.firstName = names.firstName;
    target.lastName = names.lastName;
    target.cleanPhone = cleanPhoneNumber(String(rawPayload.phone || rawPayload.phone_number || rawPayload.telephone || rawPayload.ph || ""));
    target.email = extractEmail(rawPayload);
    target.postalCode = extractPostal(rawPayload);
    
    const context = detectContext(rawPayload);
    target.industryContext = context.industry;
    target.source = rawPayload.vendor_id ? String(rawPayload.vendor_id).toLowerCase() : context.source;

    return target;
}

// Server Lifecycle Engine
const PORT = process.env.PORT || 3000;

// Flat, in-memory usage storage tracking total requests per API key
const apiKeyUsageCounters = {};

// Helper: Extracts key limits from AUTHORIZED_KEYS (Format: "keyA:1000,keyB:5000")
function getApiKeyLimit(incomingKey) {
    const systemKeysString = process.env.AUTHORIZED_KEYS || "";
    const pairs = systemKeysString.split(',').map(p => p.trim());
    
    for (const pair of pairs) {
        const [key, limitStr] = pair.split(':');
        if (key === incomingKey) {
            return limitStr ? parseInt(limitStr, 10) : Infinity;
        }
    }
    return null; // Key not found in system configuration
}
const server = http.createServer((req, res) => {
    // 1. Core Authentication & Tier Limit Verification
    const incomingKey = req.headers['x-api-key'];
    const allowedLimit = incomingKey ? getApiKeyLimit(incomingKey) : null;

    if (allowedLimit === null) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: "Unauthorized: Invalid or missing X-API-Key" }));
    }

    // Initialize counter if this is the key's first request
    if (!apiKeyUsageCounters[incomingKey]) {
        apiKeyUsageCounters[incomingKey] = 0;
    }

    // Check if the user has breached their paid monthly request allocation
    if (apiKeyUsageCounters[incomingKey] >= allowedLimit) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
            success: false, 
            error: "Payment tier quota exceeded. Please upgrade your subscription plan." 
        }));
    }

    // Increment usage counter for valid requests
    apiKeyUsageCounters[incomingKey]++;

    // 2. Connection Validation Route (Used by Make.com to verify key upon setup)
    if (req.method === 'POST' && req.url === '/v1/validate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, status: "Connected successfully" }));
    }

    // 3. Main Data Processing Route
    if (req.method === 'POST' && req.url === '/v1/normalize') {
        let body = '';
        
        req.on('data', chunk => { 
            body += chunk.toString(); 
            if (body.length > MAX_PAYLOAD_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Payload volume limit exceeded" }));
                req.destroy();
            }
        });

        req.on('end', () => {
            if (res.writableEnded) return;

            try {
                if (!body) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: "Empty request payload context" }));
                }

                const rawJson = JSON.parse(body);
                const normalizedOutput = processIncomingWebhook(rawJson);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data: normalizedOutput }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Invalid structural JSON input syntax" }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Endpoint route target not found" }));
    }
});

server.listen(PORT, () => {
    console.log(`Universal Production Normalization Engine running on port ${PORT}`);
});