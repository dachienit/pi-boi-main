import { createServer } from 'http';
import { request } from 'https';

const PARENT_PROXY = process.env.HTTPS_PROXY || process.env.http_proxy || 'http://127.0.0.1:3128';
const LISTEN_PORT = process.env.PROXY_PORT || 8888;

const proxy = createServer((req, res) => {
    // Append api-version to the incoming URL
    const targetPath = `/api/openai/deployments/gpt-5-nano-2025-08-07${req.url}?api-version=2025-04-01-preview`;
    
    console.log(`[Proxy] Forwarding ${req.method} ${req.url} -> ${targetPath}`);
    console.log(`[Proxy] Using Parent: ${PARENT_PROXY}`);

    const proxyUrl = new URL(PARENT_PROXY);
    
    const options = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: `https://aoai-farm.bosch-temp.com${targetPath}`,
        method: req.method,
        headers: {
            ...req.headers,
            host: 'aoai-farm.bosch-temp.com'
        },
        rejectUnauthorized: false
    };
    
    const proxyReq = request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });
    
    proxyReq.on('error', (err) => {
        console.error('[Proxy] Error:', err);
        res.statusCode = 500;
        res.end();
    });
    
    req.pipe(proxyReq, { end: true });
});

proxy.listen(LISTEN_PORT, () => {
    console.log(`Universal Azure Proxy listening on http://localhost:${LISTEN_PORT}`);
});
