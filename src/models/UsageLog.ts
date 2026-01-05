import mongoose, { Schema, Document } from 'mongoose';

export interface IUsageLog extends Document {
    apiKeyId: mongoose.Types.ObjectId;
    endpoint: string;
    method: string;
    statusCode: number;
    responseTime: number;
    ip: string;
    createdAt: Date;
}

const UsageLogSchema: Schema = new Schema({
    apiKeyId: { type: Schema.Types.ObjectId, ref: 'ApiKey', required: true, index: true },
    endpoint: { type: String, required: true, index: true },
    method: { type: String, required: true },
    statusCode: { type: Number, required: true },
    responseTime: { type: Number, required: true },
    ip: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true }
});

export default mongoose.model<IUsageLog>('UsageLog', UsageLogSchema);
