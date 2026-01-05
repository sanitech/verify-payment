import mongoose, { Schema, Document } from 'mongoose';

export enum Role {
    USER = 'USER',
    ADMIN = 'ADMIN'
}

export interface IUser extends Document {
    name?: string;
    email?: string;
    emailVerified?: Date;
    image?: string;
    role: Role;
}

const UserSchema: Schema = new Schema({
    name: { type: String },
    email: { type: String, unique: true, sparse: true },
    emailVerified: { type: Date },
    image: { type: String },
    role: { type: String, enum: Object.values(Role), default: Role.USER }
});

export default mongoose.model<IUser>('User', UserSchema);
