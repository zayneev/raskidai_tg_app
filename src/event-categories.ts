export type EventCategory =
  "trip" | "food" | "party" | "home" | "leisure" | "other";

export const eventCategories: readonly {
  value: EventCategory;
  label: string;
}[] = [
  { value: "trip", label: "Поездка" },
  { value: "food", label: "Еда" },
  { value: "party", label: "Праздник" },
  { value: "home", label: "Дом" },
  { value: "leisure", label: "Отдых" },
  { value: "other", label: "Другое" },
];

export const eventCategoryLabels = Object.fromEntries(
  eventCategories.map(({ value, label }) => [value, label]),
) as Record<EventCategory, string>;

const categoryWords: Record<Exclude<EventCategory, "other">, RegExp> = {
  trip: /(?:^|[^\p{L}\p{N}])(поездк|путешеств|отпуск|море|отел|гостиниц|тур|командиров|дорог|самол[её]т|поезд)\p{L}*/iu,
  food: /(?:^|[^\p{L}\p{N}])(ужин|обед|завтрак|кафе|ресторан|бар|еда|пицц|суши|шашлык)\p{L}*/iu,
  party:
    /(?:^|[^\p{L}\p{N}])(праздник|вечеринк|свадьб|день рожд|юбилей|корпоратив)\p{L}*/iu,
  home: /(?:^|[^\p{L}\p{N}])(дом|квартир|ремонт|переезд|мебел|дач)\p{L}*/iu,
  leisure:
    /(?:^|[^\p{L}\p{N}])(отдых|кино|концерт|театр|игр|поход|озер|пикник|каток|боулинг)\p{L}*/iu,
};

export function inferEventCategory(title: string): EventCategory {
  for (const [category, pattern] of Object.entries(categoryWords) as [
    Exclude<EventCategory, "other">,
    RegExp,
  ][]) {
    if (pattern.test(title)) return category;
  }
  return "other";
}

export function isEventCategory(value: unknown): value is EventCategory {
  return eventCategories.some((category) => category.value === value);
}
