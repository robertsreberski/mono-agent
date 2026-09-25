import { describe, expect, it } from "vitest";

import { selectAutomaticRecallHits } from "../recall.js";
import { CLEAR_MARGIN, selectClearMarginHit } from "../recall-margin.js";

const hit = (text: string, score: number) => ({ score, record: { text } });
const unrelated = hit("Maple prefers tea over coffee in the afternoon.", 0.7);

describe("clear-margin automatic recall", () => {
  it.each([
    ["Who is Riley?", "Riley is the building caretaker."],
    ["When was Morgan born?", "Morgan was born on 17 May 1990."],
    ["What time is Morgan's swim class?", "Morgan's swim class is on Tuesdays at 18:30."],
    ["Where does Morgan work?", "Morgan works at Initech as a data engineer."],
    ["What is the router IP of my Home Assistant box?", "Home Assistant box uses router IP 10.0.0.8 for local access."],
  ])("accepts a single-clause line with a clear margin: %s", (query, text) => {
    const top = hit(text, 0.9);
    expect(selectAutomaticRecallHits([top, unrelated], { query, ownerTurn: true })).toEqual([top]);
  });

  it("reads first-person questions as the owner only on an owner turn", () => {
    const top = hit("The user works at Initech as a data engineer.", 0.9);
    expect(selectAutomaticRecallHits([top, unrelated], { query: "Where do I work?", ownerTurn: true })).toEqual([top]);
    expect(selectAutomaticRecallHits([top, unrelated], { query: "Where do I work?" })).toEqual([]);
  });

  it("never answers a first-person question with somebody else's property", () => {
    const top = hit("Maple's blood type is O positive.", 0.95);
    expect(selectAutomaticRecallHits([top, unrelated], { query: "What is my blood type?", ownerTurn: true })).toEqual([]);
  });

  it("abstains without a clear margin over the next unrelated hit", () => {
    const top = hit("Morgan works at Initech as a data engineer.", 0.9);
    const close = hit("Maple prefers tea over coffee in the afternoon.", 0.9 - CLEAR_MARGIN / 2);
    expect(selectClearMarginHit("Where does Morgan work?", [top, close])).toEqual([]);
    expect(selectClearMarginHit("Where does Morgan work?", [top, hit(close.record.text, 0.9 - CLEAR_MARGIN)])).toEqual([top]);
  });

  it("injects close lines that also answer the question", () => {
    const top = hit("Maple is on omeprazole for reflux.", 0.95);
    const also = hit("Maple takes omeprazole daily for reflux.", 0.93);
    expect(selectClearMarginHit("Is Maple on omeprazole for reflux?", [top, also, unrelated])).toEqual([]);
    expect(selectClearMarginHit("What is Maple on for reflux?", [top, also, unrelated])).toEqual([top, also]);
  });

  it.each([
    ["When is Maple's birthday?", "Maple's birthday gift is still undecided."],
    ["What is Morgan's shoe size?", "Morgan bought new running shoes in March."],
    ["Where does Morgan work?", "Morgan does not work at Initech anymore."],
    ["Where does Morgan work?", "Morgan probably works at Initech."],
    ["Where does Morgan work?", "The assistant said Morgan works at Initech."],
    ["Where does Morgan work?", "Morgan works at Initech. Maple works at Globex."],
    ["When was Morgan born?", "Morgan was born in spring."],
    ["What color is Morgans car?", "Morgan selected cobalt as the deployment color and drives a hatchback car."],
    ["Where does Morgan work?", "Morgan works at Initech because Maple recommended it."],
    ["What did you say last message?", "Morgan said hello in the last message."],
  ])("rejects lines that do not answer: %s / %s", (query, text) => {
    expect(selectAutomaticRecallHits([hit(text, 0.95), unrelated], { query, ownerTurn: true })).toEqual([]);
  });
});
