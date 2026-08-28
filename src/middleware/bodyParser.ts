import type { Request, Response, NextFunction } from 'express';

export function jsonBodyParser(req: Request, _res: Response, next: NextFunction) {
  try {
    if ((req as any)._body) {
      next();
      return;
    }

    const contentType = (req as any).headers?.['content-type'] || '';
    if (!contentType.includes('application/json')) {
      next();
      return;
    }

    let bodyVal: any;
    try {
      const bodyDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(req), 'body');
      if (bodyDesc?.get) {
        bodyVal = bodyDesc.get.call(req);
      } else {
        bodyVal = (req as any).body;
      }
    } catch {
      bodyVal = undefined;
    }

    if (Buffer.isBuffer(bodyVal) && bodyVal.length > 0) {
      try {
        req.body = JSON.parse(bodyVal.toString('utf-8'));
        (req as any)._body = true;
      } catch (e: unknown) {
        next(e);
        return;
      }
      next();
      return;
    }

    if (typeof bodyVal === 'object' && bodyVal !== null && !Buffer.isBuffer(bodyVal)) {
      req.body = bodyVal;
      (req as any)._body = true;
      next();
      return;
    }

    (req as any)._body = true;
    next();
  } catch (e: unknown) {
    next(e);
  }
}
