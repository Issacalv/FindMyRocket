// ============================================================
// FindMyRocket -- Landing Dispersion Calculator
//
// This file contains the application UI and interaction logic.
// Pure calculation functions live in calc.js for testability.
// ============================================================

import {
    PRESSURE_LEVELS,
    FT_PER_M, FPS_PER_MS, MPH_PER_MS,
    MAX_ALTITUDE_M, MAX_ALTITUDE_FT,
    calculateDispersion, createEllipsePoints,
    bearingToCompass, calcDescentRateFromParams
} from './calc.js';

// Current unit system flag. When true, all displayed values and user
// inputs are in imperial (ft, ft/s, mph). Internal calculations always
// use metric (m, m/s).
let useImperial = true;

// Sub-unit state for toggleable unit labels.
// When true, mass displays in smaller units (g or oz instead of kg or lb).
let massSmallUnit = false;
// When true, diameter displays in smaller units (cm instead of m) — metric only.
let diaSmallUnit = false;

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
const launchAngleInput = $('launch-angle');
const launchAzimuthInput = $('launch-azimuth');
const ascentRateInput = $('ascent-rate');
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

    // Ascent rate placeholder
    ascentRateInput.placeholder = useImperial ? '150' : '45';

    // Descent rate calculator units (respect sub-unit toggle state)
    const calcMassUnit = $('calc-mass-unit');
    if (calcMassUnit) {
        if (useImperial) {
            calcMassUnit.textContent = massSmallUnit ? 'oz' : 'lb';
            $('calc-mass').placeholder = massSmallUnit ? '128' : '8';
        } else {
            calcMassUnit.textContent = massSmallUnit ? 'g' : 'kg';
            $('calc-mass').placeholder = massSmallUnit ? '3500' : '3.5';
        }
        // Diameter sub-unit only applies in metric; reset to base in imperial
        if (useImperial) {
            diaSmallUnit = false;
            $('calc-dia-unit').textContent = 'in';
            $('calc-diameter').placeholder = '48';
        } else {
            $('calc-dia-unit').textContent = diaSmallUnit ? 'cm' : 'm';
            $('calc-diameter').placeholder = diaSmallUnit ? '120' : '1.2';
        }
    }
}

// Converts all current input values between imperial and metric.
// Each field has a conversion factor: altitude fields use FT_PER_M,
// speed fields use FPS_PER_MS.
function convertInputValues(toImperial) {
    const LB_PER_KG = 2.20462;
    const OZ_PER_G = 0.035274;  // 1g = 0.035274 oz
    const IN_PER_M = 39.3701;
    const IN_PER_CM = 0.393701;

    // Mass conversion factor depends on sub-unit state:
    // kg→lb, g→oz, or the cross conversions when sub-unit is active
    let massFactor;
    if (massSmallUnit) {
        // g↔oz: 1 g = 0.035274 oz, so oz_per_g
        massFactor = OZ_PER_G;
    } else {
        massFactor = LB_PER_KG;
    }

    // Diameter: if diaSmallUnit is active (cm), convert cm→in instead of m→in
    const diaFactor = diaSmallUnit ? IN_PER_CM : IN_PER_M;

    const fields = [
        { input: apogeeInput, factor: FT_PER_M },
        { input: dr1Input, factor: FPS_PER_MS },
        { input: $('apogee-dual'), factor: FT_PER_M },
        { input: $('dr1-dual'), factor: FPS_PER_MS },
        { input: transitionInput, factor: FT_PER_M },
        { input: dr2Input, factor: FPS_PER_MS },
        { input: $('calc-mass'), factor: massFactor },
        { input: $('calc-diameter'), factor: diaFactor },
        { input: ascentRateInput, factor: FPS_PER_MS }
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
    updateDiaToggleable();
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
    updateDiaToggleable();
    if (lastDispersion) renderResults(lastDispersion, lastLaunchLat, lastLaunchLon);
});

// Set initial labels for the default unit system (imperial).
updateUnitLabels();

// --- Clickable sub-unit toggles ---
// Mass unit: click to toggle kg↔g (metric) or lb↔oz (imperial).
const calcMassUnitEl = $('calc-mass-unit');
calcMassUnitEl.classList.add('unit-toggleable');
calcMassUnitEl.title = 'Click to toggle unit';
calcMassUnitEl.addEventListener('click', () => {
    const input = $('calc-mass');
    const val = parseFloat(input.value);
    massSmallUnit = !massSmallUnit;
    if (!isNaN(val) && input.value !== '') {
        // kg↔g: ×1000, lb↔oz: ×16
        const factor = useImperial ? 16 : 1000;
        input.value = massSmallUnit
            ? +(val * factor).toPrecision(6)
            : +(val / factor).toPrecision(6);
    }
    if (useImperial) {
        calcMassUnitEl.textContent = massSmallUnit ? 'oz' : 'lb';
        input.placeholder = massSmallUnit ? '128' : '8';
    } else {
        calcMassUnitEl.textContent = massSmallUnit ? 'g' : 'kg';
        input.placeholder = massSmallUnit ? '3500' : '3.5';
    }
});

// Diameter unit: click to toggle m↔cm (metric only; inches have no natural toggle).
const calcDiaUnitEl = $('calc-dia-unit');
calcDiaUnitEl.addEventListener('click', () => {
    if (useImperial) return; // no toggle for inches
    const input = $('calc-diameter');
    const val = parseFloat(input.value);
    diaSmallUnit = !diaSmallUnit;
    if (!isNaN(val) && input.value !== '') {
        input.value = diaSmallUnit
            ? +(val * 100).toPrecision(6)
            : +(val / 100).toPrecision(6);
    }
    calcDiaUnitEl.textContent = diaSmallUnit ? 'cm' : 'm';
    input.placeholder = diaSmallUnit ? '120' : '1.2';
});

// Show toggleable styling on diameter only when metric
function updateDiaToggleable() {
    if (useImperial) {
        calcDiaUnitEl.classList.remove('unit-toggleable');
        calcDiaUnitEl.title = '';
    } else {
        calcDiaUnitEl.classList.add('unit-toggleable');
        calcDiaUnitEl.title = 'Click to toggle unit';
    }
}
updateDiaToggleable();

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

// Wind profile construction, interpolation, drift calculation,
// dispersion, ellipse fitting, and utility functions are in calc.js.

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
    const { primaryResult, primaryProfile, primaryAscentPath, ellipse, forecastTime, apogee } = dispersion;

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

    // Ascent path from launch angle simulation or OpenRocket data (if available).
    if (primaryAscentPath && primaryAscentPath.length > 1) {
        L.polyline(primaryAscentPath, {
            color: '#00d4ff', weight: 2, opacity: 0.5, dashArray: '4,6'
        }).addTo(mapLayers);

        // Apogee marker (orange dot at the top of the ascent path).
        const apogeePoint = primaryAscentPath[primaryAscentPath.length - 1];
        const apogeeIcon = L.divIcon({
            html: '<div style="background:#ff8c42;width:10px;height:10px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px rgba(255,140,66,0.6)"></div>',
            className: '', iconSize: [10, 10], iconAnchor: [5, 5]
        });
        L.marker(apogeePoint, { icon: apogeeIcon })
            .bindPopup('<b>Apogee</b>')
            .addTo(mapLayers);
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
        // Only show wind layers up to the deployment altitude, plus one
        // layer above it for context. No need to show 50,000 ft winds
        // when the rocket only reaches 1,000 ft.
        let layersAbove = 0;
        for (const layer of primaryProfile) {
            if (layer.altitude > apogee) {
                layersAbove++;
                if (layersAbove > 2) break;
            }
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

    // Parse launch angle inputs (degrees, no unit conversion needed).
    const launchAngle = parseFloat(launchAngleInput.value) || 0;
    const launchAzimuth = parseFloat(launchAzimuthInput.value) || 0;
    let ascentRate = parseFloat(ascentRateInput.value) || 0;

    // Convert user-entered imperial values to metric for internal calculations.
    if (useImperial) {
        apogee /= FT_PER_M;
        dr1 /= FPS_PER_MS;
        transition /= FT_PER_M;
        dr2 /= FPS_PER_MS;
        if (ascentRate > 0) ascentRate /= FPS_PER_MS;
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
        const orkProfile = orkFlightData ? orkFlightData.ascentProfile : null;
        const dispersion = calculateDispersion(apiData, apogee, transition, dr1, dr2, lat, lon, launchTime, isHistoricalData,
                                                launchAngle, launchAzimuth, ascentRate, orkProfile);
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
// OPENROCKET (.ork) FILE IMPORT
// ============================================================

// State for imported OpenRocket data (used for ascent visualization).
let orkFlightData = null;

// Marks an input as auto-filled (cyan highlight). The highlight clears
// when the user manually edits the field.
function markAutoFilled(input) {
    input.classList.add('auto-filled');
    input.addEventListener('input', function handler() {
        input.classList.remove('auto-filled');
        input.removeEventListener('input', handler);
    });
}

function clearAutoFilled() {
    document.querySelectorAll('.auto-filled').forEach(el => el.classList.remove('auto-filled'));
}

const orkImportBtn = $('ork-import-btn');
const orkFileInput = $('ork-file-input');
const orkSummary = $('ork-summary');

orkImportBtn.addEventListener('click', () => orkFileInput.click());

orkFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const orkData = await parseOrkFile(file);
        applyOrkData(orkData);
        showToast(`Imported: ${orkData.rocketName}`);
    } catch (err) {
        console.error('ORK import error:', err);
        showToast(err.message || 'Failed to parse .ork file', 'error');
    }
    orkFileInput.value = '';
});

// Parses an .ork file (ZIP archive containing rocket.ork XML).
async function parseOrkFile(file) {
    const buffer = await file.arrayBuffer();
    let xmlString;

    try {
        const zip = await JSZip.loadAsync(buffer);
        const xmlFile = Object.values(zip.files).find(f =>
            !f.dir && (f.name.endsWith('.ork') || f.name.endsWith('.xml'))
        );
        if (!xmlFile) throw new Error('No rocket data found in archive');
        xmlString = await xmlFile.async('string');
    } catch (zipErr) {
        // Fallback: might be raw XML (older .ork format).
        xmlString = new TextDecoder().decode(buffer);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    if (doc.querySelector('parsererror')) throw new Error('Invalid .ork file format');
    if (doc.documentElement.tagName !== 'openrocket') throw new Error('Not a valid OpenRocket file');

    return extractOrkData(doc);
}

// Walks the OpenRocket XML DOM and extracts rocket info, recovery
// devices, motor designation, mass, and simulation data.
function extractOrkData(doc) {
    const result = {
        rocketName: '',
        motorDesignation: '',
        totalMass: null,
        parachutes: [],
        simulationData: null,
        isDualDeploy: false,
        deploymentAltitude: null,
        mainDeployAltitude: null,
    };

    // Rocket name.
    const rocketNameEl = doc.querySelector('rocket > name');
    result.rocketName = rocketNameEl ? rocketNameEl.textContent.trim() : file.name.replace('.ork', '');

    // Motor designation: find the default motor config, then match its motor.
    const defaultConfig = doc.querySelector('motorconfiguration[default="true"]');
    const configId = defaultConfig ? defaultConfig.getAttribute('configid') : null;
    if (configId) {
        const motor = doc.querySelector(`motor[configid="${configId}"]`);
        if (motor) {
            const desig = motor.querySelector('designation');
            const mfg = motor.querySelector('manufacturer');
            result.motorDesignation = desig ? desig.textContent.trim() : '';
            if (mfg) result.motorDesignation = mfg.textContent.trim() + ' ' + result.motorDesignation;
        }
    }
    // Fallback: use the first motor found.
    if (!result.motorDesignation) {
        const firstMotor = doc.querySelector('motor[configid] designation');
        if (firstMotor) result.motorDesignation = firstMotor.textContent.trim();
    }

    // Recovery devices (parachutes).
    const parachuteEls = doc.querySelectorAll('parachute');
    for (const p of parachuteEls) {
        const diameter = parseFloat(p.querySelector('diameter')?.textContent) || 0;
        const cdText = p.querySelector('cd')?.textContent || '';
        const cd = cdText === 'auto' ? 0.75 : (parseFloat(cdText) || 0.75);
        const deployEvent = (p.querySelector('deployevent')?.textContent || 'apogee').toLowerCase();
        const deployAltitude = parseFloat(p.querySelector('deployaltitude')?.textContent) || 0;
        const name = p.querySelector('name')?.textContent?.trim() || '';

        result.parachutes.push({ name, diameter, cd, deployEvent, deployAltitude });
    }

    // Detect dual deploy: need at least one apogee chute and one altitude chute.
    const apogeeChutes = result.parachutes.filter(p => p.deployEvent === 'apogee');
    const altitudeChutes = result.parachutes.filter(p => p.deployEvent === 'altitude');
    if (apogeeChutes.length > 0 && altitudeChutes.length > 0) {
        result.isDualDeploy = true;
    }

    // Simulation data: find the first uptodate sim, or fall back to first sim.
    const sims = doc.querySelectorAll('simulation');
    let bestSim = null;
    for (const sim of sims) {
        if (sim.getAttribute('status') === 'uptodate') { bestSim = sim; break; }
    }
    if (!bestSim && sims.length > 0) bestSim = sims[0];

    if (bestSim) {
        const fd = bestSim.querySelector('flightdata');
        if (fd) {
            const maxAlt = parseFloat(fd.getAttribute('maxaltitude'));
            if (!isNaN(maxAlt)) result.deploymentAltitude = maxAlt;

            // Extract mass from the first datapoint (column 19 = Mass in kg).
            const branch = fd.querySelector('databranch');
            if (branch) {
                const typesStr = branch.getAttribute('types') || '';
                const types = typesStr.split(',');
                const massIdx = types.indexOf('Mass');
                const altIdx = types.indexOf('Altitude');
                const timeIdx = types.indexOf('Time');

                const datapoints = branch.querySelectorAll('datapoint');
                if (datapoints.length > 0 && massIdx >= 0) {
                    const firstVals = datapoints[0].textContent.trim().split(/\s*,\s*/);
                    const mass = parseFloat(firstVals[massIdx]);
                    if (!isNaN(mass) && mass > 0) result.totalMass = mass;
                }

                // Extract ascent profile (time, altitude) for flight visualization.
                if (timeIdx >= 0 && altIdx >= 0) {
                    const ascentProfile = [];
                    for (const dp of datapoints) {
                        const vals = dp.textContent.trim().split(/\s*,\s*/);
                        const time = parseFloat(vals[timeIdx]);
                        const alt = parseFloat(vals[altIdx]);
                        if (!isNaN(time) && !isNaN(alt)) {
                            ascentProfile.push({ time, altitude: alt });
                            // Stop after apogee (altitude starts decreasing).
                            if (ascentProfile.length > 2 && alt < ascentProfile[ascentProfile.length - 2].altitude) break;
                        }
                    }
                    if (ascentProfile.length > 2) {
                        result.simulationData = { ascentProfile };
                    }
                }

                // Extract events.
                const events = [];
                const eventEls = branch.querySelectorAll('event');
                for (const ev of eventEls) {
                    events.push({
                        time: parseFloat(ev.getAttribute('time')) || 0,
                        type: (ev.getAttribute('type') || '').toLowerCase(),
                    });
                }
                if (result.simulationData) result.simulationData.events = events;
            }
        }
    }

    // If we have altitude chutes, find the main deploy altitude.
    if (altitudeChutes.length > 0) {
        // Pick the altitude chute with the largest diameter (the main).
        const mainChute = altitudeChutes.reduce((a, b) => a.diameter > b.diameter ? a : b);
        result.mainDeployAltitude = mainChute.deployAltitude;
    }

    return result;
}

// Applies parsed .ork data to the form fields and shows the summary card.
function applyOrkData(orkData) {
    const AIR_DENSITY = 1.225;
    const GRAVITY = 9.81;

    function calcDescentRate(mass, diameter, cd) {
        const area = Math.PI * Math.pow(diameter / 2, 2);
        return Math.sqrt((2 * mass * GRAVITY) / (AIR_DENSITY * cd * area));
    }

    // Show summary card.
    $('ork-rocket-name').textContent = orkData.rocketName || 'Unknown Rocket';
    $('ork-motor').textContent = orkData.motorDesignation || '—';
    $('ork-mass').textContent = orkData.totalMass
        ? (useImperial ? `${(orkData.totalMass * 2.20462).toFixed(2)} lb` : `${orkData.totalMass.toFixed(2)} kg`)
        : '—';

    // Store simulation data for ascent visualization.
    orkFlightData = orkData.simulationData;

    if (orkData.isDualDeploy) {
        // Switch to dual deploy mode.
        if (!dualDeploy) modeDualBtn.click();

        const drogue = orkData.parachutes.find(p => p.deployEvent === 'apogee');
        const mainChutes = orkData.parachutes.filter(p => p.deployEvent === 'altitude');
        const main = mainChutes.length > 0
            ? mainChutes.reduce((a, b) => a.diameter > b.diameter ? a : b)
            : null;

        if (orkData.deploymentAltitude != null) {
            apogeeDualInput.value = useImperial
                ? (orkData.deploymentAltitude * FT_PER_M).toFixed(0)
                : orkData.deploymentAltitude.toFixed(0);
            markAutoFilled(apogeeDualInput);
        }

        if (drogue && orkData.totalMass) {
            const dr1 = calcDescentRate(orkData.totalMass, drogue.diameter, drogue.cd);
            dr1DualInput.value = useImperial ? (dr1 * FPS_PER_MS).toFixed(1) : dr1.toFixed(1);
            markAutoFilled(dr1DualInput);
        }
        if (main) {
            transitionInput.value = useImperial
                ? (main.deployAltitude * FT_PER_M).toFixed(0)
                : main.deployAltitude.toFixed(0);
            markAutoFilled(transitionInput);
            if (orkData.totalMass) {
                const dr2 = calcDescentRate(orkData.totalMass, main.diameter, main.cd);
                dr2Input.value = useImperial ? (dr2 * FPS_PER_MS).toFixed(1) : dr2.toFixed(1);
                markAutoFilled(dr2Input);
            }
        }

        $('ork-recovery').textContent = 'Dual Deploy';
    } else {
        // Switch to single deploy mode.
        if (dualDeploy) modeSingleBtn.click();

        const chute = orkData.parachutes[0];
        if (orkData.deploymentAltitude != null) {
            apogeeInput.value = useImperial
                ? (orkData.deploymentAltitude * FT_PER_M).toFixed(0)
                : orkData.deploymentAltitude.toFixed(0);
            markAutoFilled(apogeeInput);
        }
        if (chute && orkData.totalMass) {
            const dr = calcDescentRate(orkData.totalMass, chute.diameter, chute.cd);
            dr1Input.value = useImperial ? (dr * FPS_PER_MS).toFixed(1) : dr.toFixed(1);
            markAutoFilled(dr1Input);
        }

        $('ork-recovery').textContent = 'Single Deploy';
    }

    // Populate calculator fields with rocket data if available.
    if (orkData.totalMass) {
        const massEl = $('calc-mass');
        massEl.value = useImperial
            ? (orkData.totalMass * 2.20462).toFixed(2)
            : orkData.totalMass.toFixed(2);
        markAutoFilled(massEl);
    }

    // Fill chute diameter and Cd from the primary parachute.
    const primaryChute = orkData.isDualDeploy
        ? orkData.parachutes.filter(p => p.deployEvent === 'altitude')
            .reduce((a, b) => a.diameter > b.diameter ? a : b, orkData.parachutes[0])
        : orkData.parachutes[0];
    if (primaryChute) {
        const diaEl = $('calc-diameter');
        diaEl.value = useImperial
            ? (primaryChute.diameter * 39.3701).toFixed(1)
            : primaryChute.diameter.toFixed(3);
        markAutoFilled(diaEl);

        const cdEl = $('calc-cd');
        cdEl.value = primaryChute.cd;
        markAutoFilled(cdEl);
    }

    // Auto-fill ascent rate from ORK simulation profile.
    const ascentHint = $('ascent-rate-hint');
    if (orkData.simulationData && orkData.simulationData.ascentProfile) {
        const profile = orkData.simulationData.ascentProfile;
        if (profile.length >= 2) {
            const totalTime = profile[profile.length - 1].time - profile[0].time;
            const totalAlt = profile[profile.length - 1].altitude - profile[0].altitude;
            if (totalTime > 0 && totalAlt > 0) {
                const avgRate = totalAlt / totalTime; // m/s
                ascentRateInput.value = useImperial
                    ? (avgRate * FPS_PER_MS).toFixed(1)
                    : avgRate.toFixed(1);
                markAutoFilled(ascentRateInput);
            }
        }
        ascentHint.textContent = 'Using .ork simulation profile — variable thrust and coast phases included.';
        ascentHint.classList.add('ork-active');
    } else {
        ascentHint.textContent = 'Average vertical speed to apogee. Import a .ork file for accurate per-step timing.';
        ascentHint.classList.remove('ork-active');
    }

    orkSummary.hidden = false;

    if (!orkData.simulationData) {
        showToast('No simulation data — ascent path not available', 'warning');
    }
    if (!orkData.totalMass) {
        showToast('Mass not found — use the Descent Rate Calculator', 'warning');
    }
}

// Clear .ork import.
$('ork-clear-btn').addEventListener('click', () => {
    orkSummary.hidden = true;
    orkFlightData = null;
    clearAutoFilled();
    const ascentHint = $('ascent-rate-hint');
    ascentHint.textContent = 'Average vertical speed to apogee. Import a .ork file for accurate per-step timing.';
    ascentHint.classList.remove('ork-active');
    showToast('Import cleared');
});

// ============================================================
// DESCENT RATE CALCULATOR
// ============================================================

// Computes the descent rate and applies it to the appropriate field.
function computeAndApplyDR(targetField) {
    let mass = parseFloat($('calc-mass').value);
    let diameter = parseFloat($('calc-diameter').value);
    const cd = parseFloat($('calc-cd').value);

    if (isNaN(mass) || isNaN(diameter) || isNaN(cd) || mass <= 0 || diameter <= 0 || cd <= 0) {
        showToast('Enter valid mass, diameter, and Cd', 'error');
        return;
    }

    // Convert inputs to metric (kg, m) for calculation.
    if (useImperial) {
        mass = massSmallUnit ? mass / 35.274 : mass / 2.20462; // oz→kg or lb→kg
        diameter *= 0.0254; // inches to meters
    } else {
        if (massSmallUnit) mass /= 1000; // g→kg
        if (diaSmallUnit) diameter /= 100; // cm→m
    }

    const descentRate = calcDescentRateFromParams(mass, diameter, cd);

    // Display result.
    const displayRate = useImperial
        ? `${(descentRate * FPS_PER_MS).toFixed(1)} ft/s`
        : `${descentRate.toFixed(1)} m/s`;
    $('calc-result').textContent = displayRate;

    // Apply to the target field.
    const rateValue = useImperial ? (descentRate * FPS_PER_MS).toFixed(1) : descentRate.toFixed(1);
    targetField.value = rateValue;
    markAutoFilled(targetField);

    showToast(`Descent rate: ${displayRate}`);
}

// Show/hide the correct apply buttons based on deploy mode.
function updateCalcButtons() {
    $('calc-apply-single').hidden = dualDeploy;
    $('calc-apply-drogue').hidden = !dualDeploy;
    $('calc-apply-main').hidden = !dualDeploy;
}
updateCalcButtons();

$('calc-apply-single').addEventListener('click', () => computeAndApplyDR(dr1Input));
$('calc-apply-drogue').addEventListener('click', () => computeAndApplyDR(dr1DualInput));
$('calc-apply-main').addEventListener('click', () => computeAndApplyDR(dr2Input));

// Update calc buttons when deploy mode changes.
modeSingleBtn.addEventListener('click', updateCalcButtons);
modeDualBtn.addEventListener('click', updateCalcButtons);

// ============================================================
// AZIMUTH COMPASS INDICATOR
// ============================================================

// Rotates the compass arrow to match the azimuth input in real-time.
const azimuthArrow = $('azimuth-arrow');
const azimuthCompass = $('azimuth-compass');

function updateAzimuthCompass() {
    const val = parseFloat(launchAzimuthInput.value);
    if (!isNaN(val)) {
        azimuthArrow.setAttribute('transform', `rotate(${val} 18 18)`);
        azimuthCompass.classList.add('active');
    } else {
        azimuthArrow.setAttribute('transform', 'rotate(0 18 18)');
        azimuthCompass.classList.remove('active');
    }
}

launchAzimuthInput.addEventListener('input', updateAzimuthCompass);
updateAzimuthCompass();

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
    // Open the window immediately (synchronously) so mobile browsers
    // don't block it as a popup. We'll write the report content later.
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
        showToast('Popup blocked — please allow popups for this site', 'error');
        return;
    }
    // Show a loading message in the new tab while we prepare the report.
    reportWindow.document.write('<html><body style="background:#0a0e17;color:#8892a4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Generating report...</p></body></html>');

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

    // Write the finished report into the already-opened tab.
    reportWindow.document.open();
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
