import dotenv from 'dotenv';
import app from '../src/app';

function readBody(req: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    const finish = () => {
      if (!resolved) { resolved = true; resolve(Buffer.concat(chunks)); }
    };
    const drain = () => {
      let chunk;
      while ((chunk = req.read()) !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    };
    req.on('readable', drain);
    req.on('end', () => { drain(); finish(); });
    req.on('error', finish);
    drain();
    setTimeout(finish, 200);
    if (req.readableEnded) { drain(); finish(); }
  });
}

dotenv.config();

export default async (req: any, res: any) => {
  try {
    const rawBody = await readBody(req);

    if (rawBody.length > 0) {
      try {
        req.body = JSON.parse(rawBody.toString('utf-8'));
      } catch {}
    }

    if (!req.body) req.body = {};

    Object.defineProperty(req, '_body', {
      value: true,
      writable: true,
      configurable: true,
    });

    app(req, res);
  } catch (error: any) {
    console.error('FATAL:' + error.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
    }
  }
};
