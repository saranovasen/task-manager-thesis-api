export const nextId = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
