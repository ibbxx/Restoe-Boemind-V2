// The sheet displays Indonesian grouping; normalize pasted/displayed amounts before calculation.
export function numericInput(text: string) {
  const value = text.trim();
  if (value.includes(",")) return value.replace(/\./g, "").replace(",", ".");
  return /^[+-]?\d{1,3}(?:\.\d{3})+$/.test(value) ? value.replace(/\./g, "") : value;
}
