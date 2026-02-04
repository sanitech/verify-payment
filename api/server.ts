import dotenv from 'dotenv';
import serverless from 'serverless-http';

import app from '../src/app';

dotenv.config();

const handler = serverless(app);

export default async (req: any, res: any) => handler(req, res);
