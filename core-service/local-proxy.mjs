import { createServer } from 'http';
import { request } from 'https';

const LISTEN_PORT = process.env.PROXY_PORT || 8888;

const proxy = createServer((req, res) => {
    // Append api-version to the incoming URL
    const targetPath = `/api/openai/deployments/gpt-5-nano-2025-08-07${req.url}?api-version=2025-04-01-preview`;
    
    console.log(`[Proxy] Forwarding ${req.method} ${req.url} -> ${targetPath} (DIRECT)`);

    const options = {
        hostname: 'aoai-farm.bosch-temp.com',
        port: 443,
        path: targetPath,
        method: req.method,
        headers: {
            ...req.headers,
            host: 'aoai-farm.bosch-temp.com'
        },
        rejectUnauthorized: false // Ignore SSL certificate issues in corporate networks
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
    console.log(`Direct Azure Proxy listening on http://localhost:${LISTEN_PORT}`);
});
