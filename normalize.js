const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/// Strict Max Payload Size Limit: 50 Kilobytes to prevent memory flood vectors
const MAX_PAYLOAD_SIZE = 50 * 1024;
const KEYS_DIR = path.join(__dirname, 'workspace', 'active_keys');

// Ensure complete directory structure exists on the server disk array at runtime
['active_keys', 'client_index', 'project_leads', 'raw_submissions'].forEach(folder => {
    const dir = path.join(__dirname, 'workspace', folder);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
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

// Flat, in-memory usage storage tracking total requests per API key
const apiKeyUsageCounters = {};

// Map Stripe Line Item amounts to tier allocations
function getLimitFromAmount(amountTotal) {
    if (amountTotal === 2999) return 1000;
    if (amountTotal === 7999) return 5000;
    if (amountTotal === 19999) return 20000;
    return 0;
}

// Reads dynamic usage metrics directly from disk
function getApiKeyLimit(incomingKey) {
    const cleanKey = incomingKey.replace(/[^a-zA-Z0-9_]/g, '');
    const keyPath = path.join(KEYS_DIR, `${cleanKey}.json`);
    
    if (!fs.existsSync(keyPath)) {
        return null;
    }
    
    try {
        const fileContent = fs.readFileSync(keyPath, 'utf8');
        const keyData = JSON.parse(fileContent);
        if (keyData.status !== 'active') return 0;
        return keyData.limit || 0;
    } catch (e) {
        return null;
    }
}

// Server Lifecycle Engine
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    // A. STRIPE WEBHOOK LISTENER ENDPOINT (Exempt from API key headers & uses raw buffers)
    if (req.url === '/webhook' && req.method === 'POST') {
        let chunks = [];
        req.on('data', chunk => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length > MAX_PAYLOAD_SIZE) {
                req.destroy();
            }
        });
        
        req.on('end', async () => {
            const buf = Buffer.concat(chunks);
            const sig = req.headers['stripe-signature'];

            let event;
            try {
                event = stripe.webhooks.constructEvent(buf, sig, WEBHOOK_SECRET);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `Webhook Error: ${err.message}` }));
            }

            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                
                // Retrieve line items to calculate accurate subscription limitations
                let limit = 0;
                try {
                    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
                    if (lineItems.data && lineItems.data.length > 0) {
                        limit = getLimitFromAmount(lineItems.data[0].amount_total);
                    }
                } catch (err) {
                    console.error('Failed to retrieve line item details:', err);
                }

                const apiKey = `sk_norm_${crypto.randomBytes(16).toString('hex')}`;
                const keyData = {
                    customerEmail: session.customer_details.email,
                    customerId: session.customer,
                    subscriptionId: session.subscription,
                    status: 'active',
                    limit: limit,
                    createdAt: new Date().toISOString()
                };

                fs.writeFileSync(
                    path.join(KEYS_DIR, `${apiKey}.json`), 
                    JSON.stringify(keyData, null, 2)
                );
                
                console.log(`Generated active API key ${apiKey} with limit ${limit} for ${keyData.customerEmail}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
        });
        return;
    }

    // B. AUTHENTICATED RUNTIME ROUTES
    const incomingKey = req.headers['x-api-key'] || "";
    const allowedLimit = getApiKeyLimit(incomingKey);

    if (allowedLimit === null) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: "Unauthorized: Invalid or missing X-API-Key" }));
    }

    if (!apiKeyUsageCounters[incomingKey]) {
        apiKeyUsageCounters[incomingKey] = 0;
    }

    if (apiKeyUsageCounters[incomingKey] >= allowedLimit) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
            success: false, 
            error: "Payment tier quota exceeded. Please upgrade your subscription plan." 
        }));
    }

    if (req.method === 'POST' && req.url === '/v1/validate') {
        apiKeyUsageCounters[incomingKey]++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, status: "Connected successfully" }));
    }

    if (req.method === 'POST' && req.url === '/v1/normalize') {
        apiKeyUsageCounters[incomingKey]++;
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