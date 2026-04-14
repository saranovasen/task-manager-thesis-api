import mongoose from 'mongoose';

export const connectMongo = async () => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set. Add it to .env');
  }

  await mongoose.connect(mongoUri);
  return mongoose.connection;
};
