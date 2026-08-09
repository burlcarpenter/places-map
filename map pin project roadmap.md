# map pin project roadmap

- [x] satellite view — toggle button, doesn't replace the map style
- [x] open with a zoom in of current location — falls back to fitting your data if location is denied/unavailable
- [x] local-language map labels (Grand Est, not Great East)
- [x] transliterate non-Latin script names (e.g. Cyrillic) rather than showing raw script — coverage depends on OSM's name:latin tagging, not universal
- [x] category filter as a bottom-left dropdown (not scrolling chips) — emoji + colour, per-category slider toggles, "Only" isolate, "Show all" reset
- [x] country filter, same pattern, next to categories — flag badges (from countryCode), alphabetized, combines with the category filter as AND
- [x] tagging — chips on the info card, tap to search. No toggle panel (open-ended, doesn't fit that pattern)
- [x] priority/visited — Primary/Secondary/Tertiary/Visited (+ optional 1–5 star rating once visited), no Avoid. Third filter panel; set in the editor
- [x] location search (Nominatim) with a distinct temporary pin, separate from your own places — see what's nearby anywhere, not just search your saved pins
- [x] multi-category — up to 2 per place, checkbox picker in the editor, split-colour map pin (left/right hemispheres). Hard-coded "Research Needed" category, always available, not part of the editable taxonomy. Bulk categorize preserves a manually-set second category when re-mapping the primary
- integrate editor into the app
  - drop down menus

- [x] google maps API setup
- [~] cloudflare shift — considered and decided against (2026-08-09). Data's already private (repo + scoped token); Cloudflare Access would only additionally hide the empty app shell from strangers, at the cost of a second login layer and untested friction with an installed PWA. Not worth it for a single-user app. Revisit only if the goal changes to "hide that this project exists," not "keep data private."