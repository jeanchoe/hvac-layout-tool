export const newId = (prefix = '') => prefix + Math.random().toString(36).slice(2, 9);
