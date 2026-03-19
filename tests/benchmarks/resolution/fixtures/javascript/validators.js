export function validate(data) {
  return data != null && typeof data.name === 'string' && checkLength(data.name);
}

export function normalize(data) {
  return { ...data, name: trimWhitespace(data.name) };
}

function checkLength(str) {
  return str.length > 0 && str.length < 256;
}

function trimWhitespace(str) {
  return str.trim();
}
