import test from "node:test";
import assert from "node:assert/strict";
import { inferEventCategory } from "../src/event-categories.ts";

test("event category inference understands Russian titles and word boundaries", () => {
  assert.equal(inferEventCategory("Поездка на море"), "trip");
  assert.equal(inferEventCategory("Ужин с друзьями"), "food");
  assert.equal(inferEventCategory("День рождения Оли"), "party");
  assert.equal(inferEventCategory("Ремонт квартиры"), "home");
  assert.equal(inferEventCategory("Пикник у озера"), "leisure");
  assert.equal(inferEventCategory("Разбор документов"), "other");
});
