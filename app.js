// ============================================================
// FindMyRocket -- Landing Dispersion Calculator
//
// This file contains all application logic:
//   1. Constants and unit conversion factors
//   2. DOM initialization (dropdowns, date/time defaults)
//   3. Leaflet map setup (street/satellite layers, markers, draggable pin)
//   4. Location search via Nominatim geocoding API
//   5. Unit system toggle (metric/imperial) with live conversion
//   6. Wind data fetching from Open-Meteo (forecast + historical archive)
//   7. Wind profile construction and altitude interpolation
//   8. Drift simulation via numerical integration (50m steps)
//   9. Dispersion zone calculation with Monte Carlo-style perturbations
//  10. Covariance-based ellipse fitting for the 95% confidence zone
//  11. Results rendering (map overlays, result cards, wind table)
//  12. Map capture to canvas for the export feature
//  13. Export modal and HTML field report generation
// ============================================================

// --- Constants ---

// Standard atmospheric pressure levels (in hPa) used by the Open-Meteo
// forecast API. These correspond to altitudes from near sea level (~110m
// at 1000 hPa) up to ~16,180m at 100 hPa. Wind speed, wind direction,
// and geopotential height are fetched at each of these levels.
const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100];

// Approximate altitudes (meters) for each pressure level, used as a
// fallback when the API doesn't return geopotential height data.
// Values are from the International Standard Atmosphere (ISA).
const FALLBACK_ALTITUDES = {
    1000: 110, 975: 320, 950: 540, 925: 760, 900: 990,
    850: 1460, 800: 1950, 700: 3010, 600: 4210, 500: 5570,
    400: 7190, 300: 9160, 250: 10360, 200: 11780, 150: 13600, 100: 16180
};

// Altitude step size (meters) for the numerical integration during
// drift calculation. Smaller steps = more accurate but slower.
const ALT_STEP = 50;

const DEG_TO_RAD = Math.PI / 180;

// Approximate meters per degree of latitude (constant everywhere on Earth).
// Longitude conversion requires an additional cos(latitude) factor.
const METERS_PER_DEG_LAT = 111320;

// --- Unit System ---

const FT_PER_M = 3.28084;       // feet per meter
const FPS_PER_MS = 3.28084;     // ft/s per m/s (same numeric value)
const MPH_PER_MS = 2.23694;     // mph per m/s

// Hard altitude cap based on the highest pressure level (100 hPa).
// Prevents out-of-memory from extremely large altitude inputs, since the
// drift loop creates one path point per 50m step.
const MAX_ALTITUDE_M = 16200;
const MAX_ALTITUDE_FT = Math.round(MAX_ALTITUDE_M * FT_PER_M);

// Current unit system flag. When true, all displayed values and user
// inputs are in imperial (ft, ft/s, mph). Internal calculations always
// use metric (m, m/s).
let useImperial = true;

// --- DOM refs ---
// Shorthand for getElementById used throughout the file.
const $ = (id) => document.getElementById(id);
const form = $('calc-form');
const latInput = $('latitude');
const lonInput = $('longitude');
const apogeeInput = $('apogee');
const dr1Input = $('dr1');
const transitionInput = $('transition');
const dr2Input = $('dr2');
const launchDateInput = $('launch-date');
const launchHourSelect = $('launch-hour');
const launchMinSelect = $('launch-min');
const loadingOverlay = $('loading-overlay');
const formError = $('form-error');
const resultsPanel = $('results-panel');

// Updates both the lat/lon input fields and the draggable map pin.
// Called from search results, GPS, manual input, and pin drag events.
function setCoords(lat, lon) {
    latInput.value = parseFloat(lat).toFixed(6);
    lonInput.value = parseFloat(lon).toFixed(6);
    if (typeof updatePinPosition === 'function') updatePinPosition(parseFloat(lat), parseFloat(lon));
}

// --- Populate hour/minute dropdowns ---
// Hours: 00-23, minutes: 00/15/30/45 (15-minute intervals)
for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = String(h).padStart(2, '0');
    launchHourSelect.appendChild(opt);
}
for (let m = 0; m < 60; m += 15) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = String(m).padStart(2, '0');
    launchMinSelect.appendChild(opt);
}

// Sets the date and time inputs to the current local date/time,
// snapping minutes to the nearest 15-minute interval.
function setDateTimeToNow() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    launchDateInput.value = `${yyyy}-${mm}-${dd}`;
    launchHourSelect.value = now.getHours();
    const nearest15 = Math.round(now.getMinutes() / 15) * 15;
    launchMinSelect.value = nearest15 >= 60 ? 45 : nearest15;
}
setDateTimeToNow();

// ============================================================
// MAP INITIALIZATION
// ============================================================

// Default view centered on Mojave Desert area (common rocketry launch site).
const map = L.map('map').setView([35.35, -117.81], 12);

// Street tile layer from OpenStreetMap.
// crossOrigin: 'anonymous' is required for the map capture feature
// to draw tile images onto a canvas without tainting it.
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    crossOrigin: 'anonymous'
});

// Satellite imagery layer from Esri/ArcGIS.
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    crossOrigin: 'anonymous'
});

// Street layer is shown by default. Layer control in the top-right
// corner lets the user switch to satellite.
streetLayer.addTo(map);
L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, null, { position: 'topright' }).addTo(map);

// Layer group that holds all result overlays (markers, polylines, ellipse).
// Cleared and rebuilt on each new calculation.
let mapLayers = L.layerGroup().addTo(map);

// Small colored dot icons for the launch (orange) and landing (cyan) markers.
const launchIcon = L.divIcon({
    html: '<div style="background:#ff4c29;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 8px rgba(255,76,41,0.6)"></div>',
    className: '', iconSize: [14, 14], iconAnchor: [7, 7]
});
const landingIcon = L.divIcon({
    html: '<div style="background:#00d4ff;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 8px rgba(0,212,255,0.6)"></div>',
    className: '', iconSize: [14, 14], iconAnchor: [7, 7]
});

// --- Draggable Launch Pin ---
// Large teardrop-shaped pin that the user can drag to set the launch location.
// Initially placed at [0,0] but not added to the map until a location is set.
const pinIcon = L.divIcon({
    html: `<div style="position:relative;width:30px;height:42px">
        <svg viewBox="0 0 30 42" width="30" height="42" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="#ff4c29" stroke="#fff" stroke-width="2"/>
            <circle cx="15" cy="14" r="6" fill="#fff"/>
        </svg>
    </div>`,
    className: '', iconSize: [30, 42], iconAnchor: [15, 42]
});
let launchPin = L.marker([0, 0], { icon: pinIcon, draggable: true });
let pinVisible = false;

// When the user finishes dragging the pin, update the coordinate inputs.
launchPin.on('dragend', () => {
    const pos = launchPin.getLatLng();
    setCoords(pos.lat, pos.lng);
});

// Moves the pin to a new position. Adds the pin to the map on first call.
function updatePinPosition(lat, lon) {
    if (!isNaN(lat) && !isNaN(lon)) {
        launchPin.setLatLng([lat, lon]);
        if (!pinVisible) {
            launchPin.addTo(map);
            pinVisible = true;
        }
    }
}

// ============================================================
// LOCATION SEARCH (Nominatim / OpenStreetMap)
// ============================================================

const searchInput = $('location-search');
const searchResults = $('search-results');
let searchTimeout = null;

// Debounced search: waits 350ms after the user stops typing before
// querying Nominatim. Requires at least 3 characters.
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (query.length < 3) {
        searchResults.hidden = true;
        return;
    }
    searchTimeout = setTimeout(() => searchLocation(query), 350);
});

// Queries the Nominatim geocoding API and displays up to 5 results
// in a dropdown below the search input.
async function searchLocation(query) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return;
        const results = await res.json();
        searchResults.innerHTML = '';
        if (results.length === 0) {
            searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
            searchResults.hidden = false;
            return;
        }
        for (const r of results) {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.textContent = r.display_name;
            item.addEventListener('click', () => {
                setCoords(r.lat, r.lon);
                map.setView([parseFloat(r.lat), parseFloat(r.lon)], 14);
                searchInput.value = r.display_name;
                searchResults.hidden = true;
                showToast('Location set');
            });
            searchResults.appendChild(item);
        }
        searchResults.hidden = false;
    } catch (e) {
        // Silently fail -- user can still enter coords manually
    }
}

// Close the search dropdown when clicking anywhere outside it.
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
        searchResults.hidden = true;
    }
});

// --- Pan map when coordinates are typed manually ---
// When the user edits lat/lon inputs directly, move the map and pin
// to match (only if the values are valid coordinates).
function onCoordsChanged() {
    const lat = parseFloat(latInput.value);
    const lon = parseFloat(lonInput.value);
    if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        map.setView([lat, lon], Math.max(map.getZoom(), 12));
        updatePinPosition(lat, lon);
    }
}
latInput.addEventListener('change', onCoordsChanged);
lonInput.addEventListener('change', onCoordsChanged);

// --- Geolocation ---
// Uses the browser's Geolocation API (GPS) to set the launch location.
$('gps-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return showToast('Geolocation not supported', 'error');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            setCoords(pos.coords.latitude, pos.coords.longitude);
            map.setView([pos.coords.latitude, pos.coords.longitude], 14);
            showToast('Location acquired');
        },
        (err) => showToast('Could not get location — enter manually', 'error'),
        { enableHighAccuracy: true, timeout: 10000 }
    );
});

// --- Now Button ---
// Resets the date/time inputs to the current moment.
$('now-btn').addEventListener('click', () => {
    setDateTimeToNow();
    showToast('Set to current time');
});

// ============================================================
// UNIT TOGGLE (Metric / Imperial)
// ============================================================

const metricBtn = $('unit-metric');
const imperialBtn = $('unit-imperial');

// Updates all unit labels, table headers, and placeholder text
// throughout the UI to reflect the current unit system.
function updateUnitLabels() {
    // Input field labels (e.g., "ft AGL" or "m AGL")
    document.querySelectorAll('.unit-alt').forEach(el => {
        el.textContent = useImperial ? 'ft AGL' : 'm AGL';
    });
    document.querySelectorAll('.unit-speed').forEach(el => {
        el.textContent = useImperial ? 'ft/s' : 'm/s';
    });
    // Wind table column headers
    document.querySelectorAll('.unit-alt-short').forEach(el => {
        el.textContent = useImperial ? 'ft' : 'm';
    });
    document.querySelectorAll('.unit-speed-short').forEach(el => {
        el.textContent = useImperial ? 'mph' : 'm/s';
    });
    // Input placeholder values (representative typical values)
    apogeeInput.placeholder = useImperial ? '1640' : '500';
    dr1Input.placeholder = useImperial ? '16' : '5';
    $('apogee-dual').placeholder = useImperial ? '1640' : '500';
    $('dr1-dual').placeholder = useImperial ? '49' : '15';
    transitionInput.placeholder = useImperial ? '656' : '200';
    dr2Input.placeholder = useImperial ? '16' : '5';
}

// Converts all current input values between imperial and metric.
// Each field has a conversion factor: altitude fields use FT_PER_M,
// speed fields use FPS_PER_MS.
function convertInputValues(toImperial) {
    const fields = [
        { input: apogeeInput, factor: FT_PER_M },
        { input: dr1Input, factor: FPS_PER_MS },
        { input: $('apogee-dual'), factor: FT_PER_M },
        { input: $('dr1-dual'), factor: FPS_PER_MS },
        { input: transitionInput, factor: FT_PER_M },
        { input: dr2Input, factor: FPS_PER_MS }
    ];
    for (const { input, factor } of fields) {
        const val = parseFloat(input.value);
        if (!isNaN(val) && input.value !== '') {
            input.value = toImperial
                ? (val * factor).toFixed(1)
                : (val / factor).toFixed(1);
        }
    }
}

// Switch to metric: convert existing values, update labels, re-render results.
metricBtn.addEventListener('click', () => {
    if (!useImperial) return;
    convertInputValues(false);
    useImperial = false;
    metricBtn.classList.add('active');
    imperialBtn.classList.remove('active');
    updateUnitLabels();
    if (lastDispersion) renderResults(lastDispersion, lastLaunchLat, lastLaunchLon);
});

// Switch to imperial: convert existing values, update labels, re-render results.
imperialBtn.addEventListener('click', () => {
    if (useImperial) return;
    convertInputValues(true);
    useImperial = true;
    imperialBtn.classList.add('active');
    metricBtn.classList.remove('active');
    updateUnitLabels();
    if (lastDispersion) renderResults(lastDispersion, lastLaunchLat, lastLaunchLon);
});

// Set initial labels for the default unit system (imperial).
updateUnitLabels();

// --- Hard altitude clamp on input ---
// Prevents the user from typing or pasting a value above the maximum
// supported altitude. Fires on every keystroke/input event, immediately
// replacing the value with the max if exceeded.
function clampAltitudeInput(input) {
    input.addEventListener('input', () => {
        const max = useImperial ? MAX_ALTITUDE_FT : MAX_ALTITUDE_M;
        const val = parseFloat(input.value);
        if (!isNaN(val) && val > max) {
            input.value = max;
            showToast(`Max altitude: ${max.toLocaleString()} ${useImperial ? 'ft' : 'm'}`, 'error');
        }
    });
}
clampAltitudeInput(apogeeInput);
clampAltitudeInput($('apogee-dual'));
clampAltitudeInput(transitionInput);

// ============================================================
// OPEN-METEO API -- Wind Data Fetching
// ============================================================

// Flag set during fetchWindData to indicate whether the response came
// from the historical archive API (surface winds only) or the forecast
// API (full pressure-level data). Used by buildWindProfile to choose
// the correct parsing strategy.
let isHistoricalData = false;

// Fetches hourly wind data from the Open-Meteo API.
//
// For future/current dates: uses the forecast API with wind speed,
// direction, and geopotential height at all 16 pressure levels.
//
// For past dates: uses the archive API which only provides surface
// winds at 10m and 100m above ground. The buildWindProfile function
// then extrapolates these to higher altitudes.
//
// Returns the raw JSON response from the API.
async function fetchWindData(lat, lon, launchTime) {
    const now = new Date();
    // Compare dates only (ignore time) to determine if the launch date is in the past.
    isHistoricalData = launchTime && launchTime < new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let url;
    if (isHistoricalData) {
        // Request a 3-day window around the target date to ensure we have
        // enough hourly data points for the closest-hour lookup.
        const startDate = new Date(launchTime);
        startDate.setDate(startDate.getDate() - 1);
        const endDate = new Date(launchTime);
        endDate.setDate(endDate.getDate() + 1);
        const fmt = d => d.toISOString().slice(0, 10);
        const hourly = 'wind_speed_10m,wind_direction_10m,wind_speed_100m,wind_direction_100m,surface_pressure';
        url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=${hourly}&wind_speed_unit=ms&start_date=${fmt(startDate)}&end_date=${fmt(endDate)}&timezone=auto`;
    } else {
        // Build parameter lists for all pressure levels.
        const windParams = [];
        const geoParams = [];
        for (const p of PRESSURE_LEVELS) {
            windParams.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`);
            geoParams.push(`geopotential_height_${p}hPa`);
        }
        const hourly = [...windParams, ...geoParams].join(',');
        url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hourly}&wind_speed_unit=ms&forecast_days=16&timezone=auto`;
    }

    // 10-second timeout to avoid hanging on slow connections.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return await res.json();
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') throw new Error('Request timed out — check your connection');
        throw e;
    }
}

// ============================================================
// WIND PROFILE CONSTRUCTION
// ============================================================

// Builds an array of { altitude, speed, direction } objects for a
// given hour index in the API response. The array is sorted by
// altitude (ascending), which is required for interpolation.
//
// For forecast data: each pressure level provides a direct measurement.
// For historical data: only 10m and 100m winds are available, so higher
// altitudes are extrapolated using the power-law wind profile model:
//   speed(z) = speed_ref * (z / z_ref) ^ alpha
// where alpha is derived from the ratio of 100m to 10m wind speeds.
function buildWindProfile(data, hourIndex) {
    const profile = [];

    if (isHistoricalData) {
        // Extract the two available surface wind measurements.
        const spd10 = data.hourly.wind_speed_10m?.[hourIndex] ?? 0;
        const dir10 = data.hourly.wind_direction_10m?.[hourIndex] ?? 0;
        const spd100 = data.hourly.wind_speed_100m?.[hourIndex] ?? spd10;
        const dir100 = data.hourly.wind_direction_100m?.[hourIndex] ?? dir10;

        profile.push({ altitude: 10, speed: spd10, direction: dir10 });
        profile.push({ altitude: 100, speed: spd100, direction: dir100 });

        // Power-law extrapolation to higher altitudes.
        // alpha is the wind shear exponent. Typical values:
        //   0.10-0.15 for open terrain, 0.25-0.40 for urban areas.
        // Clamped to [0.05, 0.4] to avoid unreasonable extrapolation.
        const refSpeed = Math.max(spd100, spd10, 0.5);
        const alpha = spd10 > 0.01 ? Math.log(spd100 / spd10) / Math.log(100 / 10) : 0.14;
        const clampedAlpha = Math.max(0.05, Math.min(alpha, 0.4));

        // Extrapolate at representative altitudes up to 16,000m.
        // Wind direction is held constant (same as 100m) since the
        // archive API provides no directional data at altitude.
        const alts = [250, 500, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 16000];
        for (const alt of alts) {
            const speed = refSpeed * Math.pow(alt / 100, clampedAlpha);
            profile.push({ altitude: alt, speed, direction: dir100 });
        }

        profile.sort((a, b) => a.altitude - b.altitude);
        return profile;
    }

    // Forecast path: extract wind data at each pressure level.
    for (const p of PRESSURE_LEVELS) {
        const speed = data.hourly[`wind_speed_${p}hPa`]?.[hourIndex];
        const dir = data.hourly[`wind_direction_${p}hPa`]?.[hourIndex];
        const geoAlt = data.hourly[`geopotential_height_${p}hPa`]?.[hourIndex];
        if (speed == null || dir == null) continue;
        // Use geopotential height if available, otherwise fall back to ISA.
        const alt = geoAlt != null ? geoAlt : FALLBACK_ALTITUDES[p];
        profile.push({ altitude: alt, speed, direction: dir });
    }
    profile.sort((a, b) => a.altitude - b.altitude);
    return profile;
}

// Returns interpolated wind speed and direction at an arbitrary altitude
// by linearly interpolating between the two nearest profile layers.
// Below the lowest layer, returns the lowest layer's values.
// Above the highest layer, returns the highest layer's values.
// Direction interpolation handles the 0/360 wrap-around correctly.
function interpolateWind(profile, alt) {
    if (profile.length === 0) return { speed: 0, direction: 0 };
    if (alt <= profile[0].altitude) return { speed: profile[0].speed, direction: profile[0].direction };
    if (alt >= profile[profile.length - 1].altitude) {
        const top = profile[profile.length - 1];
        return { speed: top.speed, direction: top.direction };
    }
    for (let i = 0; i < profile.length - 1; i++) {
        if (alt >= profile[i].altitude && alt <= profile[i + 1].altitude) {
            // Linear interpolation factor (0 = lower layer, 1 = upper layer)
            const t = (alt - profile[i].altitude) / (profile[i + 1].altitude - profile[i].altitude);
            const speed = profile[i].speed + t * (profile[i + 1].speed - profile[i].speed);
            // Direction wrap-around: if the difference exceeds 180 degrees,
            // adjust so interpolation takes the shorter arc.
            let d1 = profile[i].direction;
            let d2 = profile[i + 1].direction;
            let diff = d2 - d1;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            const direction = ((d1 + t * diff) % 360 + 360) % 360;
            return { speed, direction };
        }
    }
    return { speed: 0, direction: 0 };
}

// ============================================================
// DRIFT CALCULATION (Numerical Integration)
// ============================================================

// Simulates the rocket's descent from apogee to ground, accumulating
// horizontal displacement caused by wind at each altitude step.
//
// Parameters (all in metric):
//   profile      -- wind profile array from buildWindProfile
//   apogee       -- deployment altitude in meters AGL
//   transitionAlt -- altitude (m) where drogue switches to main chute
//                    (0 for single deploy)
//   dr1          -- descent rate (m/s) on drogue / single chute
//   dr2          -- descent rate (m/s) on main chute
//   launchLat/Lon -- launch site coordinates in decimal degrees
//
// Returns an object with:
//   landingLat/Lon -- predicted landing coordinates
//   totalTime      -- total descent time in seconds
//   driftDistance   -- straight-line distance from launch to landing (m)
//   driftBearing   -- compass bearing from launch to landing (degrees)
//   path           -- array of [lat, lon] points for drawing the drift path
//   dx, dy         -- total east-west and north-south displacement (m)
function calculateDrift(profile, apogee, transitionAlt, dr1, dr2, launchLat, launchLon) {
    let dx = 0, dy = 0;
    let totalTime = 0;
    const path = [[launchLat, launchLon]];
    // Clamp to max altitude as a safety measure (form validation should
    // already prevent this, but defense in depth).
    let currentAlt = Math.min(apogee, MAX_ALTITUDE_M);

    while (currentAlt > 0) {
        // Use a smaller step if we're close to the ground to avoid
        // overshooting below zero.
        const step = Math.min(ALT_STEP, currentAlt);

        // Sample wind at the midpoint of this altitude step for better accuracy.
        const midAlt = currentAlt - step / 2;

        // Select the appropriate descent rate based on current altitude
        // relative to the main chute deployment altitude.
        const descentRate = currentAlt > transitionAlt ? dr1 : dr2;

        // Time to descend through this altitude step.
        const dt = step / descentRate;
        totalTime += dt;

        const wind = interpolateWind(profile, midAlt);

        // Wind direction is meteorological (where wind comes FROM).
        // Add 180 degrees to get the direction of travel (where the rocket
        // is pushed TO).
        const dirRad = (wind.direction + 180) * DEG_TO_RAD;

        // Accumulate horizontal displacement.
        // sin(dir) gives east-west component, cos(dir) gives north-south.
        dx += wind.speed * Math.sin(dirRad) * dt;
        dy += wind.speed * Math.cos(dirRad) * dt;

        currentAlt -= step;

        // Record the current position for the drift path polyline.
        const dlat = dy / METERS_PER_DEG_LAT;
        const dlon = dx / (METERS_PER_DEG_LAT * Math.cos(launchLat * DEG_TO_RAD));
        path.push([launchLat + dlat, launchLon + dlon]);
    }

    // Final landing position.
    const dlat = dy / METERS_PER_DEG_LAT;
    const dlon = dx / (METERS_PER_DEG_LAT * Math.cos(launchLat * DEG_TO_RAD));
    const landingLat = launchLat + dlat;
    const landingLon = launchLon + dlon;
    const driftDistance = Math.sqrt(dx * dx + dy * dy);
    const driftBearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;

    return { landingLat, landingLon, totalTime, driftDistance, driftBearing, path, dx, dy };
}

// ============================================================
// DISPERSION ZONE CALCULATION
// ============================================================

// Runs multiple drift simulations with perturbed parameters to estimate
// the range of possible landing locations (dispersion zone).
//
// Perturbation strategy:
//   - 6 consecutive forecast hours (captures temporal wind variation)
//   - 3 wind speed factors: 0.8x, 1.0x, 1.2x
//   - 3 direction offsets: -15, 0, +15 degrees
//   - 3 descent rate factors: 0.9x, 1.0x, 1.1x
//
// Total scenarios: 6 hours * 3 speeds * 3 dirs * 3 rates = 162
//
// The unperturbed result (speed=1.0, dir=0, rate=1.0, closest hour)
// is saved as the primary prediction shown on the map.
function calculateDispersion(apiData, apogee, transitionAlt, dr1, dr2, lat, lon, launchTime) {
    const landingPoints = [];

    // Find the hour index in the API response closest to the planned launch time.
    const target = launchTime || new Date();
    const times = apiData.hourly.time.map(t => new Date(t));
    let baseIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
        const diff = Math.abs(times[i] - target);
        if (diff < minDiff) { minDiff = diff; baseIdx = i; }
    }

    // Use the closest hour plus the next 5 hours.
    const hourIndices = [];
    for (let h = 0; h < 6 && baseIdx + h < times.length; h++) {
        hourIndices.push(baseIdx + h);
    }

    // Perturbation factors for Monte Carlo-style dispersion estimation.
    const speedFactors = [0.8, 1.0, 1.2];
    const dirOffsets = [-15, 0, 15];
    const drFactors = [0.9, 1.0, 1.1];

    let primaryResult = null;
    let primaryProfile = null;

    for (const hi of hourIndices) {
        const profile = buildWindProfile(apiData, hi);
        for (const sf of speedFactors) {
            for (const dOff of dirOffsets) {
                for (const drf of drFactors) {
                    // Create a perturbed copy of the wind profile.
                    const perturbedProfile = profile.map(p => ({
                        altitude: p.altitude,
                        speed: p.speed * sf,
                        direction: (p.direction + dOff + 360) % 360
                    }));
                    const result = calculateDrift(perturbedProfile, apogee, transitionAlt, dr1 * drf, dr2 * drf, lat, lon);
                    landingPoints.push({ lat: result.landingLat, lon: result.landingLon });

                    // The unperturbed, closest-hour result is the primary prediction.
                    if (hi === baseIdx && sf === 1.0 && dOff === 0 && drf === 1.0) {
                        primaryResult = result;
                        primaryProfile = profile;
                    }
                }
            }
        }
    }

    // Fit a 95% confidence ellipse to all landing points.
    const ellipse = fitEllipse(landingPoints, lat);
    const forecastTime = times[baseIdx];
    return { primaryResult, primaryProfile, ellipse, landingPoints, forecastTime };
}

// Fits a 2-sigma (95% confidence) ellipse to a set of landing points
// using principal component analysis (eigendecomposition of the 2x2
// covariance matrix).
//
// Returns: { centerLat, centerLon, semiMajor, semiMinor, rotation }
//   semiMajor/Minor are in meters, rotation is in degrees.
function fitEllipse(points, refLat) {
    const n = points.length;
    if (n < 3) return null;

    // Compute the centroid (mean) of all landing points.
    const meanLat = points.reduce((s, p) => s + p.lat, 0) / n;
    const meanLon = points.reduce((s, p) => s + p.lon, 0) / n;

    // Convert lat/lon offsets to meters relative to the centroid.
    const cosLat = Math.cos(meanLat * DEG_TO_RAD);
    const xs = points.map(p => (p.lon - meanLon) * METERS_PER_DEG_LAT * cosLat);
    const ys = points.map(p => (p.lat - meanLat) * METERS_PER_DEG_LAT);

    // Build the 2x2 covariance matrix [cxx, cxy; cxy, cyy].
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < n; i++) {
        cxx += xs[i] * xs[i];
        cyy += ys[i] * ys[i];
        cxy += xs[i] * ys[i];
    }
    cxx /= n; cyy /= n; cxy /= n;

    // Eigenvalues of a 2x2 symmetric matrix via the quadratic formula.
    const trace = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const lambda1 = trace / 2 + disc;
    const lambda2 = trace / 2 - disc;

    // Scale by 2-sigma for 95% confidence interval.
    const semiMajor = 2 * Math.sqrt(Math.max(0, lambda1));
    const semiMinor = 2 * Math.sqrt(Math.max(0, lambda2));

    // Rotation angle of the major axis (eigenvector direction).
    const rotation = Math.atan2(cxy, lambda1 - cyy) * 180 / Math.PI;

    return { centerLat: meanLat, centerLon: meanLon, semiMajor, semiMinor, rotation };
}

// Generates an array of [lat, lon] points forming an ellipse on the map.
// Used to draw the dispersion zone as a Leaflet polygon.
function createEllipsePoints(center, semiMajor, semiMinor, rotationDeg, numPoints = 72) {
    const points = [];
    const rot = rotationDeg * DEG_TO_RAD;
    const cosLat = Math.cos(center[0] * DEG_TO_RAD);
    for (let i = 0; i < numPoints; i++) {
        const angle = (2 * Math.PI * i) / numPoints;
        // Parametric ellipse in local meters.
        const x = semiMajor * Math.cos(angle);
        const y = semiMinor * Math.sin(angle);
        // Rotate by the ellipse orientation angle.
        const xr = x * Math.cos(rot) - y * Math.sin(rot);
        const yr = x * Math.sin(rot) + y * Math.cos(rot);
        // Convert back to lat/lon.
        const lat = center[0] + yr / METERS_PER_DEG_LAT;
        const lon = center[1] + xr / (METERS_PER_DEG_LAT * cosLat);
        points.push([lat, lon]);
    }
    return points;
}

// ============================================================
// RESULTS RENDERING
// ============================================================

// Cache the last dispersion result so we can re-render when the user
// toggles between metric and imperial without re-fetching data.
let lastDispersion = null;
let lastLaunchLat = null;
let lastLaunchLon = null;

// Renders all calculation results: map overlays, result cards, and wind table.
function renderResults(dispersion, lat, lon) {
    lastDispersion = dispersion;
    lastLaunchLat = lat;
    lastLaunchLon = lon;
    const { primaryResult, primaryProfile, ellipse, forecastTime } = dispersion;

    // Clear previous overlays (markers, paths, ellipse).
    mapLayers.clearLayers();

    // Launch site marker (orange dot).
    L.marker([lat, lon], { icon: launchIcon })
        .bindPopup('<b>Launch Site</b>')
        .addTo(mapLayers);

    // Dashed polyline showing the predicted drift path from launch to landing.
    L.polyline(primaryResult.path, {
        color: '#ff4c29', weight: 2, opacity: 0.7, dashArray: '6,4'
    }).addTo(mapLayers);

    // Landing site marker (cyan dot).
    L.marker([primaryResult.landingLat, primaryResult.landingLon], { icon: landingIcon })
        .bindPopup('<b>Predicted Landing</b>')
        .addTo(mapLayers);

    // Dispersion ellipse polygon (semi-transparent orange fill).
    if (ellipse && ellipse.semiMajor > 0) {
        const pts = createEllipsePoints(
            [ellipse.centerLat, ellipse.centerLon],
            ellipse.semiMajor, ellipse.semiMinor, ellipse.rotation
        );
        L.polygon(pts, {
            color: '#ff4c29', fillColor: '#ff4c29', fillOpacity: 0.12, weight: 2, dashArray: '4,4'
        }).addTo(mapLayers);
    }

    // Auto-zoom the map to fit all overlays with some padding.
    const bounds = L.latLngBounds([[lat, lon], [primaryResult.landingLat, primaryResult.landingLon]]);
    if (ellipse) {
        const pts = createEllipsePoints(
            [ellipse.centerLat, ellipse.centerLon],
            ellipse.semiMajor, ellipse.semiMinor, ellipse.rotation
        );
        pts.forEach(p => bounds.extend(p));
    }
    map.fitBounds(bounds.pad(0.3));

    // --- Update result card values ---

    $('res-landing').textContent =
        `${primaryResult.landingLat.toFixed(5)}, ${primaryResult.landingLon.toFixed(5)}`;

    // Drift distance: show in ft/mi or m/km depending on unit system.
    const dist = primaryResult.driftDistance;
    if (useImperial) {
        const distFt = dist * FT_PER_M;
        $('res-distance').textContent = distFt < 5280
            ? `${distFt.toFixed(0)} ft`
            : `${(distFt / 5280).toFixed(2)} mi`;
    } else {
        $('res-distance').textContent = dist < 1000
            ? `${dist.toFixed(0)} m`
            : `${(dist / 1000).toFixed(2)} km`;
    }

    // Drift bearing with compass direction (e.g., "106 deg (E)").
    $('res-bearing').textContent =
        `${primaryResult.driftBearing.toFixed(0)}° (${bearingToCompass(primaryResult.driftBearing)})`;

    // Total descent time formatted as seconds or minutes+seconds.
    $('res-time').textContent =
        primaryResult.totalTime < 60
            ? `${primaryResult.totalTime.toFixed(0)} s`
            : `${Math.floor(primaryResult.totalTime / 60)}m ${Math.round(primaryResult.totalTime % 60)}s`;

    // Dispersion zone dimensions (major x minor axis).
    if (ellipse) {
        if (useImperial) {
            $('res-dispersion').textContent =
                `${Math.round(ellipse.semiMajor * 2 * FT_PER_M)} x ${Math.round(ellipse.semiMinor * 2 * FT_PER_M)} ft`;
        } else {
            $('res-dispersion').textContent =
                `${Math.round(ellipse.semiMajor * 2)} x ${Math.round(ellipse.semiMinor * 2)} m`;
        }
    } else {
        $('res-dispersion').textContent = '—';
    }

    // Forecast time used for the primary prediction.
    if (forecastTime) {
        $('res-forecast-time').textContent = forecastTime.toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    // --- Wind profile table ---
    // Shows wind speed and direction at each altitude layer.
    const tbody = document.querySelector('#wind-table tbody');
    tbody.innerHTML = '';
    if (primaryProfile) {
        for (const layer of primaryProfile) {
            const alt = useImperial ? (layer.altitude * FT_PER_M).toFixed(0) : Math.round(layer.altitude);
            const spd = useImperial ? (layer.speed * MPH_PER_MS).toFixed(1) : layer.speed.toFixed(1);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${alt}</td>
                <td>${spd}</td>
                <td>${layer.direction.toFixed(0)}° (${bearingToCompass(layer.direction)})</td>
            `;
            tbody.appendChild(tr);
        }
    }

    resultsPanel.hidden = false;
}

// ============================================================
// UTILITIES
// ============================================================

// Converts a bearing (0-360 degrees) to an 8-point compass direction.
function bearingToCompass(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

// Shows a temporary notification at the bottom center of the screen.
// Auto-removes after 3.5 seconds.
function showToast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// Displays a form validation error below the submit button.
function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
}

// Hides the form validation error.
function clearError() {
    formError.hidden = true;
}

// ============================================================
// FORM SUBMISSION
// ============================================================

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    // Parse inputs. Which fields to read depends on the deploy mode.
    const lat = parseFloat(latInput.value);
    const lon = parseFloat(lonInput.value);
    let apogee, dr1, transition, dr2;

    if (dualDeploy) {
        apogee = parseFloat(apogeeDualInput.value);
        dr1 = parseFloat(dr1DualInput.value);
        transition = parseFloat(transitionInput.value);
        dr2 = parseFloat(dr2Input.value);
    } else {
        apogee = parseFloat(apogeeInput.value);
        dr1 = parseFloat(dr1Input.value);
        transition = 0;
        dr2 = dr1; // Single deploy: same descent rate the whole way down
    }

    // Convert user-entered imperial values to metric for internal calculations.
    if (useImperial) {
        apogee /= FT_PER_M;
        dr1 /= FPS_PER_MS;
        transition /= FT_PER_M;
        dr2 /= FPS_PER_MS;
    }

    // Parse launch date and time from the form inputs.
    const launchDateVal = launchDateInput.value;
    if (!launchDateVal) return showError('Please set a launch date');
    const hh = String(launchHourSelect.value).padStart(2, '0');
    const mm = String(launchMinSelect.value).padStart(2, '0');
    const launchTime = new Date(`${launchDateVal}T${hh}:${mm}`);
    if (isNaN(launchTime.getTime())) return showError('Invalid date or time');

    // Date range validation: forecast API only covers 16 days ahead.
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const maxForecast = new Date(today);
    maxForecast.setDate(maxForecast.getDate() + 16);
    if (launchTime > maxForecast) return showError('Date is too far in the future — forecast data is only available up to 16 days ahead');

    // Input validation.
    if (isNaN(lat) || isNaN(lon) || !latInput.value || !lonInput.value) return showError('Set a location — search, use GPS, or enter coordinates');
    if (lat < -90 || lat > 90) return showError('Latitude must be between -90 and 90');
    if (lon < -180 || lon > 180) return showError('Longitude must be between -180 and 180');
    if (isNaN(apogee) || apogee <= 0) return showError('Deployment altitude must be a positive number');
    if (apogee > MAX_ALTITUDE_M) {
        const maxDisp = useImperial ? `${MAX_ALTITUDE_FT.toLocaleString()} ft` : `${MAX_ALTITUDE_M.toLocaleString()} m`;
        return showError(`Altitude exceeds maximum of ${maxDisp} — limited by available wind data`);
    }
    if (isNaN(dr1) || dr1 <= 0) return showError('Descent rate must be positive');
    if (dualDeploy) {
        if (isNaN(transition) || transition < 0) return showError('Main deployment altitude must be >= 0');
        if (isNaN(dr2) || dr2 <= 0) return showError('Main chute descent rate must be positive');
        if (transition >= apogee) return showError('Main deployment altitude must be less than apogee');
    }

    // Show loading spinner and disable the button while fetching.
    const btn = $('calc-btn');
    btn.disabled = true;
    loadingOverlay.classList.add('active');

    try {
        const apiData = await fetchWindData(lat, lon, launchTime);
        if (isHistoricalData) {
            showToast('Historical date — using surface wind extrapolation (less accurate above 100m)', 'warning');
        }
        const dispersion = calculateDispersion(apiData, apogee, transition, dr1, dr2, lat, lon, launchTime);
        renderResults(dispersion, lat, lon);
    } catch (err) {
        console.error('FindMyRocket error:', err);
        showError(err.message || 'Failed to fetch wind data');
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false;
        loadingOverlay.classList.remove('active');
    }
});

// ============================================================
// DEPLOY MODE TOGGLE (Single / Dual)
// ============================================================

let dualDeploy = false;
const singleFields = $('single-deploy-fields');
const dualFields = $('dual-deploy-fields');
const modeSingleBtn = $('mode-single');
const modeDualBtn = $('mode-dual');
const apogeeDualInput = $('apogee-dual');
const dr1DualInput = $('dr1-dual');

// Switch to single deploy: show single fields, hide dual fields,
// and update the HTML required attributes so form validation works
// correctly for hidden inputs.
modeSingleBtn.addEventListener('click', () => {
    if (!dualDeploy) return;
    dualDeploy = false;
    modeSingleBtn.classList.add('active');
    modeDualBtn.classList.remove('active');
    singleFields.hidden = false;
    dualFields.hidden = true;
    apogeeInput.required = true;
    dr1Input.required = true;
    apogeeDualInput.required = false;
    dr1DualInput.required = false;
    transitionInput.required = false;
    dr2Input.required = false;
});

// Switch to dual deploy: show dual fields (drogue + main), hide single fields.
modeDualBtn.addEventListener('click', () => {
    if (dualDeploy) return;
    dualDeploy = true;
    modeDualBtn.classList.add('active');
    modeSingleBtn.classList.remove('active');
    singleFields.hidden = true;
    dualFields.hidden = false;
    apogeeInput.required = false;
    dr1Input.required = false;
    apogeeDualInput.required = true;
    dr1DualInput.required = true;
    transitionInput.required = true;
    dr2Input.required = true;
});

// ============================================================
// MAP CAPTURE (for Export)
// ============================================================

// Extracts the x,y offset from a CSS translate3d() transform string.
// Used to position Leaflet map elements correctly on the export canvas.
// Leaflet uses translate3d for GPU-accelerated positioning of tiles,
// overlays, and markers within nested pane containers.
function parseTranslate3d(el) {
    const t = (el.style ? el.style.transform : el) || '';
    const m = t.match(/translate3d\(([^,]+),\s*([^,]+)/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
}

// Captures the current map view (tiles + vector overlays + markers)
// to a canvas element and returns it as a data URL (PNG).
//
// This works by reading the already-loaded DOM elements rather than
// re-fetching tiles, so it's fast and works offline. The canvas is
// rendered at 2x resolution for crisp export output.
//
// Leaflet's DOM structure (relevant to capture):
//   .leaflet-map-pane (has translate3d offset from map origin)
//     .leaflet-tile-pane
//       .leaflet-tile-container (one per zoom level, has translate3d)
//         img (individual tiles, each with translate3d position)
//     .leaflet-overlay-pane
//       svg (contains polylines, polygons as SVG paths)
//     .leaflet-marker-pane
//       .leaflet-marker-icon (each marker, positioned with translate3d)
async function captureMapCanvas() {
    const mapEl = document.getElementById('map');
    const size = map.getSize();
    const canvas = document.createElement('canvas');
    canvas.width = size.x * 2;
    canvas.height = size.y * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    // The map pane itself has a translate3d offset that all child
    // elements are positioned relative to. We need to apply this
    // offset when drawing each child onto the canvas.
    const mapPane = mapEl.querySelector('.leaflet-map-pane');
    const [px, py] = mapPane ? parseTranslate3d(mapPane) : [0, 0];

    // --- Draw tile images ---
    // Each tile container holds 256x256 tile images positioned with
    // translate3d. The final canvas position for each tile is:
    //   mapPane offset + container offset + individual tile offset
    const tilePane = mapEl.querySelector('.leaflet-tile-pane');
    if (tilePane) {
        const containers = tilePane.querySelectorAll('.leaflet-tile-container');
        containers.forEach(container => {
            const [ox, oy] = parseTranslate3d(container);
            container.querySelectorAll('img').forEach(img => {
                try {
                    const [ix, iy] = parseTranslate3d(img);
                    const w = img.width || 256;
                    const h = img.height || 256;
                    ctx.drawImage(img, px + ox + ix, py + oy + iy, w, h);
                } catch (e) { /* skip tainted tiles (CORS) */ }
            });
        });
    }

    // --- Draw vector overlays (polylines, polygons) ---
    // Leaflet renders these as SVG in the overlay pane. We serialize
    // the SVG to a blob, load it as an image, and draw it on the canvas.
    const svgOverlay = mapEl.querySelector('.leaflet-overlay-pane svg');
    if (svgOverlay) {
        const svgData = new XMLSerializer().serializeToString(svgOverlay);
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, px, py);
                URL.revokeObjectURL(url);
                resolve();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(); // Continue without SVG overlay
            };
            img.src = url;
        });
    }

    // --- Draw markers as circles ---
    // Leaflet markers are div-based icons. We find each one's position
    // and draw a colored circle to represent it on the canvas.
    const markerPane = mapEl.querySelector('.leaflet-marker-pane');
    if (markerPane) {
        markerPane.querySelectorAll('.leaflet-marker-icon').forEach(marker => {
            const [mx, my] = parseTranslate3d(marker);
            const dot = marker.querySelector('div[style]');
            if (dot) {
                const bg = dot.style.background || dot.style.backgroundColor || '#ff4c29';
                const w = parseFloat(dot.style.width) || 14;
                ctx.beginPath();
                ctx.arc(px + mx + w / 2, py + my + w / 2, w / 2, 0, Math.PI * 2);
                ctx.fillStyle = bg;
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        });
    }

    return canvas.toDataURL('image/png');
}

// ============================================================
// EXPORT FEATURE
// ============================================================

const exportModal = $('export-modal');
const exportBtn = $('export-btn');
const exportClose = $('export-close');
const exportGo = $('export-go');
const exportStatus = $('export-status');

// Open/close the export modal.
exportBtn.addEventListener('click', () => { exportModal.hidden = false; });
exportClose.addEventListener('click', () => { exportModal.hidden = true; });
// Close modal when clicking the backdrop (outside the dialog).
exportModal.addEventListener('click', (e) => {
    if (e.target === exportModal) exportModal.hidden = true;
});

// Map view toggle buttons in the export modal (street vs satellite).
document.querySelectorAll('.export-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.export-view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// Generate and open the field report in a new browser tab.
// The report is a self-contained HTML document with inline styles,
// designed for printing or saving as PDF.
exportGo.addEventListener('click', async () => {
    exportGo.disabled = true;
    exportStatus.hidden = false;
    exportStatus.textContent = 'Preparing map...';

    // Determine which map view to capture and which data to include.
    const wantSatellite = document.querySelector('.export-view-btn[data-view="satellite"]').classList.contains('active');
    const checks = {
        map: $('exp-map').checked,
        landing: $('exp-landing').checked,
        distance: $('exp-distance').checked,
        bearing: $('exp-bearing').checked,
        time: $('exp-time').checked,
        dispersion: $('exp-dispersion').checked,
        forecast: $('exp-forecast').checked,
        wind: $('exp-wind').checked,
        launch: $('exp-launch').checked,
    };

    // If the export needs a different map layer than what's currently
    // shown, switch layers temporarily and wait for tiles to load.
    const currentIsSatellite = map.hasLayer(satelliteLayer);
    const needSwitch = (wantSatellite && !currentIsSatellite) || (!wantSatellite && currentIsSatellite);
    if (needSwitch) {
        map.removeLayer(wantSatellite ? streetLayer : satelliteLayer);
        const newLayer = wantSatellite ? satelliteLayer : streetLayer;
        map.addLayer(newLayer);
        await new Promise(r => newLayer.once('load', r));
    }

    // Capture the map as a PNG data URL.
    let mapDataUrl = null;
    if (checks.map) {
        try {
            exportStatus.textContent = 'Capturing map...';
            mapDataUrl = await captureMapCanvas();
        } catch (err) {
            console.error('Map capture failed:', err);
            exportStatus.textContent = 'Map capture failed — generating report without map';
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Restore the original map layer if we switched.
    if (needSwitch) {
        map.removeLayer(wantSatellite ? satelliteLayer : streetLayer);
        map.addLayer(wantSatellite ? streetLayer : satelliteLayer);
    }

    // --- Build the HTML report ---
    exportStatus.textContent = 'Generating report...';
    const now = new Date();
    const reportDate = now.toLocaleString([], {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    // Assemble the data rows based on which checkboxes are selected.
    let dataRows = '';
    if (checks.launch) {
        dataRows += reportRow('Launch Location', `${latInput.value}, ${lonInput.value}`);
    }
    if (checks.landing) {
        dataRows += reportRow('Predicted Landing', $('res-landing').textContent);
    }
    if (checks.distance) {
        dataRows += reportRow('Drift Distance', $('res-distance').textContent);
    }
    if (checks.bearing) {
        dataRows += reportRow('Drift Bearing', $('res-bearing').textContent);
    }
    if (checks.time) {
        dataRows += reportRow('Descent Time', $('res-time').textContent);
    }
    if (checks.dispersion) {
        dataRows += reportRow('Dispersion Zone', $('res-dispersion').textContent);
    }
    if (checks.forecast) {
        dataRows += reportRow('Forecast Time', $('res-forecast-time').textContent);
    }

    // Build the wind profile table HTML if requested.
    let windTableHtml = '';
    if (checks.wind) {
        const rows = document.querySelectorAll('#wind-table tbody tr');
        if (rows.length > 0) {
            const altUnit = useImperial ? 'ft' : 'm';
            const spdUnit = useImperial ? 'mph' : 'm/s';
            let trs = '';
            rows.forEach(tr => {
                const tds = tr.querySelectorAll('td');
                trs += `<tr><td>${tds[0].textContent}</td><td>${tds[1].textContent}</td><td>${tds[2].textContent}</td></tr>`;
            });
            windTableHtml = `
                <h3 style="margin:16px 0 6px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.5px">Wind Profile</h3>
                <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:Consolas,monospace">
                    <thead><tr style="border-bottom:2px solid #333">
                        <th style="text-align:left;padding:4px 8px;color:#888">Alt (${altUnit})</th>
                        <th style="text-align:left;padding:4px 8px;color:#888">Speed (${spdUnit})</th>
                        <th style="text-align:left;padding:4px 8px;color:#888">Direction</th>
                    </tr></thead>
                    <tbody>${trs}</tbody>
                </table>`;
        }
    }

    // Self-contained HTML report with dark theme and print-friendly styles.
    const reportHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>FindMyRocket Field Report</title>
<style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0e17; color:#e0e6f0; padding:20px; max-width:800px; margin:0 auto; }
    .header { display:flex; align-items:center; gap:8px; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #2a3450; }
    .header h1 { font-size:20px; background:linear-gradient(90deg,#ff4c29,#ff8c42); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .header .date { margin-left:auto; color:#8892a4; font-size:12px; }
    .map-img { width:100%; border-radius:8px; border:1px solid #2a3450; margin-bottom:16px; }
    .data-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
    .data-item { background:#1a2236; border:1px solid #2a3450; border-radius:8px; padding:10px 12px; }
    .data-label { font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#8892a4; margin-bottom:3px; }
    .data-value { font-size:15px; font-weight:600; font-family:Consolas,'SF Mono',monospace; }
    table td { padding:3px 8px; border-bottom:1px solid #1a2236; }
    .footer { margin-top:20px; padding-top:10px; border-top:1px solid #2a3450; color:#8892a4; font-size:11px; text-align:center; }
    @media print {
        body { background:#fff; color:#111; padding:10px; }
        .data-item { background:#f5f5f5; border-color:#ddd; }
        .data-label { color:#666; }
        table td { border-color:#ddd; color:#111; }
        .footer { color:#999; border-color:#ddd; }
        .header h1 { -webkit-text-fill-color:#ff4c29; }
    }
</style></head><body>
    <div class="header">
        <h1>FindMyRocket</h1>
        <span style="color:#8892a4;font-size:13px">Field Report</span>
        <span class="date">${reportDate}</span>
    </div>
    ${mapDataUrl ? `<img class="map-img" src="${mapDataUrl}" alt="Map">` : ''}
    <div class="data-grid">${dataRows}</div>
    ${windTableHtml}
    <div class="footer">Generated by FindMyRocket Landing Dispersion Calculator</div>
    <script>window.onafterprint=()=>{};window.onload=()=>{document.title='FindMyRocket_Report_${now.toISOString().slice(0,10)}'}<\/script>
</body></html>`;

    // Open the report in a new tab for printing/saving.
    const reportWindow = window.open('', '_blank');
    reportWindow.document.write(reportHtml);
    reportWindow.document.close();

    exportStatus.textContent = 'Report opened — print or save as PDF';
    exportGo.disabled = false;
    setTimeout(() => { exportStatus.hidden = true; }, 3000);
});

// Helper: generates one data card for the export report HTML.
function reportRow(label, value) {
    return `<div class="data-item"><div class="data-label">${label}</div><div class="data-value">${value}</div></div>`;
}
