import { describe, expect, it } from "vitest";
import { contactSelectionInput, contactWhere } from "../lib/contact-selection";

describe("bulk directory selection", () => {
  it("requires one explicit selection mode", () => {
    expect(contactSelectionInput.safeParse({}).success).toBe(false);
    expect(contactSelectionInput.safeParse({ contactIds: ["a"], filter: {} }).success).toBe(false);
    expect(contactSelectionInput.safeParse({ filter: {} }).success).toBe(true);
  });
  it("keeps group scope when combined with a contradictory source filter", () => {
    // “Other” excludes group members, so these combined conditions match nothing.
    expect(contactWhere({ groupId: "g", source: "other" }).members).toEqual({ some: { groupId: "g" }, none: {} });
    expect(contactWhere({ groupId: "g", source: "groups" }).members).toEqual({ some: { groupId: "g" } });
  });
  it("combines phone provenance and segment scope without adding a sender restriction", () => {
    expect(contactWhere({ source: "mine", segmentId: "s" })).toEqual({ isMyContact: true, segments: { some: { segmentId: "s" } } });
    expect(contactWhere({ unsegmented: true }).segments).toEqual({ none: {} });
  });
  it("filters stored identity type independently of phone visibility and opt-in", () => {
    expect(contactWhere({ destinationAvailability: "private", phoneAvailability: "unavailable", consent: "OPTED_IN" }))
      .toEqual({ whatsappId: { endsWith: "@lid" }, phone: null, consent: "OPTED_IN" });
    expect(contactWhere({ destinationAvailability: "phone" })).toEqual({ whatsappId: { endsWith: "@c.us" } });
    // A suffix filter is a directory aid; campaign eligibility still validates
    // the full identifier and never treats an arbitrary username as an ID.
    expect(contactSelectionInput.safeParse({ filter: { destinationAvailability: "private" } }).success).toBe(true);
    expect(contactSelectionInput.safeParse({ filter: { destinationAvailability: "valid" } }).success).toBe(false);
  });
});
