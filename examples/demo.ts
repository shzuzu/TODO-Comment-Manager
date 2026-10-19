/** Пример для проверки панели TODO Manager. */
export function calculateTotal(prices: number[]): number {
  // TODO[HIGH]: Добавить проверку отрицательных цен
  // FIXME[MEDIUM]: Округлять денежные значения до копеек
  return prices.reduce((total, price) => total + price, 0);
}

// BUG[CRITICAL]: Обработать отсутствие пользователя перед чтением профиля
// TODO[LOW]: Добавить примеры использования API
const sample = "TODO: это строка, а не задача";
console.log(sample);
