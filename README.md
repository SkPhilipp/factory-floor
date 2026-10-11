# factory-floor
Experiment to throw a factory at!

The Dark Factory is a small static site of plain HTML and CSS in `site/`, with one page per topic. Run `npm test` to check that every page has a title, the stylesheet link and no broken relative links.

## State file

`scripts/floor-state.mjs` produces `site/state.json` from the GitHub issues, their `factory:*` and `strike:*` labels, the bb threads and the gate and review reports. The script only writes the file, and only when its content changed. The factory loop runs it after every state change; when `site/state.json` changed, the loop publishes it through a pull request on the branch `floor/state`, merged by Release like every other change, never a direct push to the base.
