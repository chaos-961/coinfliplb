# Coinflip LB frontend — compliance copy update

Static frontend files only. Backend/API files were not changed.

## What changed

- Replaced risky visible copy that could imply real-money or prize play with entertainment-only Fun Gold wording.
- Added 18+ and no-real-money/no-cash-value/no-prize disclosures on the landing screen, dashboard, and footer.
- Added a signup confirmation checkbox for 18+ and Fun Gold-only acknowledgement.
- Added static `terms.html`, `privacy.html`, and `responsible-play.html` pages.
- Kept the game mechanics and backend API contract unchanged.

## Deploy

Upload these files to your static frontend host as before. Make sure `config.js` still points to your backend API and the backend `FRONTEND_ORIGIN` includes your frontend domain.
