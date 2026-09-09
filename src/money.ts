// Parse decimal text without floating-point multiplication or implicit rounding.
export function parseRubles(value: string): number | null {
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return amount > 0 && amount <= 99999999999 ? amount : null;
}
export function rublesInput(amount: number): string {
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}
export function formatMoney(amount: number): string {
  return `${Math.floor(amount / 100).toLocaleString("ru-RU")},${String(amount % 100).padStart(2, "0")} ₽`;
}
