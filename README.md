# FindMyRocket

Landing dispersion calculator for high-power rocketry. Predicts where a rocket will land based on real wind data, deployment altitude, and descent rate.

Live site: findmyrocket.com

## What It Does

- Fetches real wind data from the Open-Meteo API at multiple pressure levels (surface up to 100 hPa / ~53,000 ft)
- Simulates rocket descent through the wind profile using numerical integration (50m altitude steps)
- Supports both single-deploy (one parachute) and dual-deploy (drogue + main) recovery configurations
- Calculates a dispersion ellipse (95% confidence) by perturbing wind speed, direction, and descent rate across multiple forecast hours
- Supports historical dates using the Open-Meteo archive API (surface wind extrapolation, less accurate above 100m)
- Exports a field report with map screenshot, results, and wind profile table

## How It Works

### Wind Data

For future/current dates, the app queries the Open-Meteo forecast API for wind speed and direction at 16 pressure levels (1000 hPa to 100 hPa), plus geopotential height at each level to convert pressure to altitude.

For historical dates, the archive API only provides 10m and 100m surface winds. The app extrapolates to higher altitudes using a power-law wind profile model.

### Drift Calculation

Starting at apogee, the calculator steps down in 50m increments. At each step it:

1. Looks up (or interpolates) the wind speed and direction at that altitude
2. Computes horizontal displacement using wind velocity and the time to descend through that step
3. Accumulates total east-west (dx) and north-south (dy) displacement

For dual deploy, the descent rate switches from drogue rate to main chute rate at the transition altitude.

### Dispersion Zone

To estimate landing uncertainty, the app runs the drift calculation across:

- 6 consecutive forecast hours (to capture temporal wind variation)
- 3 wind speed perturbation factors (0.8x, 1.0x, 1.2x)
- 3 wind direction offsets (-15 deg, 0, +15 deg)
- 3 descent rate factors (0.9x, 1.0x, 1.1x)

This produces 162 simulated landing points. A 2-sigma covariance ellipse is fitted to these points to show the 95% confidence dispersion zone.

## Tech Stack

- Vanilla HTML/CSS/JavaScript (no build tools or frameworks)
- Leaflet.js for the interactive map (street + satellite layers)
- Open-Meteo API for wind forecast and historical data
- Nominatim (OpenStreetMap) for location search/geocoding
- Hosted on GitHub Pages

## File Structure

- `index.html` -- Page structure, form inputs, results panel, export modal
- `style.css` -- Dark theme styling, responsive breakpoints, CSS custom properties
- `app.js` -- All application logic: API calls, wind profile building, drift simulation, map rendering, export

## Limitations

- Maximum altitude: ~53,150 ft (16,200 m), limited by the highest pressure level available from Open-Meteo (100 hPa)
- Historical wind data only has surface-level measurements (10m and 100m); higher altitudes are extrapolated and less accurate
- Forecast data is available up to 16 days ahead
- The model assumes vertical descent only (no horizontal flight during ascent, no ballistic trajectory)
- Wind direction interpolation assumes smooth transitions between pressure levels
