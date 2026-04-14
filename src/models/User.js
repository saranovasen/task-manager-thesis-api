import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

export const UserModel = mongoose.model('User', userSchema);
