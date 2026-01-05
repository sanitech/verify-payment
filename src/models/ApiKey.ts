import mongoose, { Schema, Document } from 'mongoose';

export interface IApiKey extends Document {
    key: string;
    owner: string;
    createdAt: Date;
    lastUsed?: Date;
    usageCount: number;
    isActive: boolean;
    userId?: mongoose.Types.ObjectId;
}

const ApiKeySchema: Schema = new Schema({
    key: { type: String, required: true, unique: true, index: true },
    owner: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    lastUsed: { type: Date },
    usageCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' }
});

export default mongoose.model<IApiKey>('ApiKey', ApiKeySchema);
