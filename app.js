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
    bearingToCompass, calcDescentRateFromParams,
    computeRodTiltOffset,
    computeWeathercockFormula, computeWeathercockOrkBackfit
} from './calc.js';

// Hard limits for all numeric input fields. These are enforced both via
// HTML max/min attributes and programmatically when loading .fmr files,
// so hand-edited session files cannot inject out-of-range values.
const INPUT_LIMITS = {
    latitude:      { min: -90,   max: 90 },
    longitude:     { min: -180,  max: 180 },
    launchAngle:   { min: 0,     max: 15 },
    launchAzimuth: { min: 0,     max: 360 },
    ascentRate:    { min: 0,     max: 1500 },   // ft/s or m/s — well above any HPR
    apogee:        { min: 1,     max: 53150 },  // hard ceiling from API pressure levels
    apogeeDual:    { min: 1,     max: 53150 },
    transition:    { min: 0,     max: 53150 },
    dr1:           { min: 0.1,   max: 500 },    // well above ballistic terminal velocity
    dr1Dual:       { min: 0.1,   max: 500 },
    dr2:           { min: 0.1,   max: 500 },
    calcMass:      { min: 0.01,  max: 10000 },  // covers lb, kg, oz, g sub-units
    calcDiameter:  { min: 0.01,  max: 10000 },  // covers in, m, cm sub-units
    calcCd:        { min: 0.01,  max: 3 },      // no real Cd exceeds ~2.2
};

// Clamp a numeric value to the defined limits for a given field.
// Returns the clamped value, or '' if the input is not a valid number.
function clampInput(fieldKey, rawValue) {
    const v = parseFloat(rawValue);
    if (isNaN(v) || rawValue === '' || rawValue == null) return '';
    const lim = INPUT_LIMITS[fieldKey];
    if (!lim) return v;
    return Math.min(Math.max(v, lim.min), lim.max);
}

// Current unit system flag. When true, all displayed values and user
// inputs are in imperial (ft, ft/s, mph). Internal calculations always
// use metric (m, m/s).
let useImperial = true;

// Sub-unit state for toggleable unit labels.
// When true, mass displays in smaller units (g or oz instead of kg or lb).
let massSmallUnit = false;
// When true, diameter displays in smaller units (cm instead of m) — metric only.
let diaSmallUnit = false;

// ============================================================
// SCENARIO COMPARISON STATE
// ============================================================

// Pinned scenarios for side-by-side comparison.
let scenarios = [];
let activeScenarioIndex = -1; // -1 = current/unsaved result
let currentVisible = true;    // toggle map visibility for current result

// Wind data cache: avoids re-fetching when only rocket params change.
const windDataCache = new Map();

// Distinct colors for scenario overlays on the map.
const SCENARIO_COLORS = ['#ff4c29', '#00d4ff', '#a855f7', '#22c55e', '#f59e0b'];
const MAX_SCENARIOS = 5; // includes current unsaved result

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
const launchAmpmSelect = $('launch-ampm');
let use24h = true; // 24-hour time format by default
const launchAngleInput = $('launch-angle');
const launchAzimuthInput = $('launch-azimuth');
const ascentRateInput = $('ascent-rate');
const loadingOverlay = $('loading-overlay');
const formError = $('form-error');
const resultsPanel = $('results-panel');

// Map DOM input ids to their INPUT_LIMITS keys. Used below to attach
// real-time clamping on every keystroke, matching the altitude fields.
const INPUT_ID_TO_KEY = {
    'latitude': 'latitude', 'longitude': 'longitude',
    'launch-angle': 'launchAngle', 'launch-azimuth': 'launchAzimuth',
    'ascent-rate': 'ascentRate',
    'dr1': 'dr1', 'dr1-dual': 'dr1Dual', 'dr2': 'dr2',
    'calc-mass': 'calcMass', 'calc-diameter': 'calcDiameter', 'calc-cd': 'calcCd',
};

// Updates both the lat/lon input fields and the draggable map pin.
// Called from search results, GPS, manual input, and pin drag events.
function setCoords(lat, lon) {
    latInput.value = parseFloat(lat).toFixed(6);
    lonInput.value = parseFloat(lon).toFixed(6);
    if (typeof updatePinPosition === 'function') updatePinPosition(parseFloat(lat), parseFloat(lon));
}

// --- Populate hour/minute dropdowns ---
const timeFormatLabel = $('time-format-label');

function populateHourSelect() {
    const currentVal = parseInt(launchHourSelect.value, 10);
    launchHourSelect.innerHTML = '';
    if (use24h) {
        for (let h = 0; h < 24; h++) {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = String(h).padStart(2, '0');
            launchHourSelect.appendChild(opt);
        }
        launchAmpmSelect.style.display = 'none';
    } else {
        for (let h = 1; h <= 12; h++) {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = String(h);
            launchHourSelect.appendChild(opt);
        }
        launchAmpmSelect.style.display = '';
    }
    // Restore selection if valid
    if (!isNaN(currentVal)) launchHourSelect.value = currentVal;
}

populateHourSelect();

// Minutes: 15-minute intervals (00/15/30/45)
for (let m = 0; m < 60; m += 15) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = String(m).padStart(2, '0');
    launchMinSelect.appendChild(opt);
}

// Sets the date and time inputs to the current local date/time.
function setDateTimeToNow() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    launchDateInput.value = `${yyyy}-${mo}-${dd}`;
    let h = now.getHours();
    if (!use24h) {
        launchAmpmSelect.value = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
    }
    launchHourSelect.value = h;
    // Floor to current 15-minute slot (matches dropdown options 0/15/30/45)
    launchMinSelect.value = Math.floor(now.getMinutes() / 15) * 15;
}
setDateTimeToNow();

// --- 12h / 24h Toggle (clickable label) ---
timeFormatLabel.addEventListener('click', () => {
    const oldH = parseInt(launchHourSelect.value, 10);
    const hadValue = !isNaN(oldH);

    if (use24h) {
        // Switch to 12h
        use24h = false;
        timeFormatLabel.textContent = '12h';
        let h12 = oldH, ampm = 'AM';
        if (hadValue) {
            ampm = oldH >= 12 ? 'PM' : 'AM';
            h12 = oldH % 12 || 12;
        }
        populateHourSelect();
        if (hadValue) {
            launchHourSelect.value = h12;
            launchAmpmSelect.value = ampm;
        }
    } else {
        // Switch to 24h
        use24h = true;
        timeFormatLabel.textContent = '24h';
        let h24 = oldH;
        if (hadValue) {
            const isPM = launchAmpmSelect.value === 'PM';
            h24 = (oldH % 12) + (isPM ? 12 : 0);
        }
        populateHourSelect();
        if (hadValue) launchHourSelect.value = h24;
    }
});

// ============================================================
// MAP INITIALIZATION
// ============================================================

// Default view centered on Mojave Desert area (common rocketry launch site).
// minZoom + maxBounds prevent the user from zooming/panning into a
// repeating world (the "infinite earths" effect at low zoom).
const map = L.map('map', {
    minZoom: 2,
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1.0,
    worldCopyJump: false,
}).setView([35.35, -117.81], 12);

// Street tile layer from OpenStreetMap.
// crossOrigin: 'anonymous' is required for the map capture feature
// to draw tile images onto a canvas without tainting it.
// noWrap stops tiles from repeating horizontally past the antimeridian.
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true,
    crossOrigin: 'anonymous'
});

// Satellite imagery layer from Esri/ArcGIS.
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    noWrap: true,
    crossOrigin: 'anonymous'
});

// Street layer is shown by default. Layer control in the top-right
// corner lets the user switch to satellite.
streetLayer.addTo(map);
L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, null, { position: 'topright' }).addTo(map);

// Layer group that holds all result overlays (markers, polylines, ellipse).
// Cleared and rebuilt on each new calculation.
let mapLayers = L.layerGroup().addTo(map);

// Map legend control (bottom-left). Built lazily after icon helpers are
// declared below — see initMapLegend(), called at end of init.
let mapLegendControl = null;

// Inline SVG glyphs for the trajectory waypoints. Each icon is rendered
// inside an L.divIcon so Leaflet positions them; the export pipeline
// detects the inner <svg> and rasterizes it onto the canvas.
const LAUNCH_COLOR = '#ff4c29';
function launchIconSvg(color = LAUNCH_COLOR, size = 18) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 42" width="${size}" height="${size * 42 / 30}" style="filter:drop-shadow(0 0 4px ${color}aa)">
        <path d="M15 1C7.3 1 1 7.3 1 15c0 9.5 14 26 14 26s14-16.5 14-26C29 7.3 22.7 1 15 1z" fill="${color}" stroke="#fff" stroke-width="2"/>
        <circle cx="15" cy="14" r="5" fill="#fff"/>
    </svg>`;
}
function apogeeIconSvg(color, size = 18) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="${size}" height="${size}" style="filter:drop-shadow(0 0 4px ${color}aa)">
        <polygon points="10,1 19,18 1,18" fill="${color}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    </svg>`;
}
function landingIconSvg(color, size = 20) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" style="filter:drop-shadow(0 0 4px ${color}aa)">
        <path d="M2 11 C2 5, 22 5, 22 11" fill="${color}" stroke="#fff" stroke-width="1.5"/>
        <line x1="2"  y1="11" x2="12" y2="20" stroke="#fff" stroke-width="1.5"/>
        <line x1="8"  y1="11" x2="12" y2="20" stroke="#fff" stroke-width="1.5"/>
        <line x1="16" y1="11" x2="12" y2="20" stroke="#fff" stroke-width="1.5"/>
        <line x1="22" y1="11" x2="12" y2="20" stroke="#fff" stroke-width="1.5"/>
        <circle cx="12" cy="20" r="2" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    </svg>`;
}

const launchIcon = L.divIcon({
    html: launchIconSvg(),
    className: 'fmr-marker fmr-launch', iconSize: [18, 25], iconAnchor: [9, 25]
});
// landingIcon replaced by makeLandingIcon(color) for per-scenario colors.

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

// Builds the legend HTML (also reused by the export report).
function buildLegendHtml() {
    const swatch = (svg, label) =>
        `<div class="legend-row"><span class="legend-icon">${svg}</span><span class="legend-label">${label}</span></div>`;
    const lineSwatch = (style, label) =>
        `<div class="legend-row"><span class="legend-line" style="${style}"></span><span class="legend-label">${label}</span></div>`;
    const sampleColor = '#4dd2ff';
    return `
        <div class="legend-header">
            <span>Map Legend</span>
            <button class="legend-toggle" type="button" title="Collapse">&minus;</button>
        </div>
        <div class="legend-body">
            ${swatch(launchIconSvg(LAUNCH_COLOR, 14), 'Launch')}
            ${swatch(apogeeIconSvg(sampleColor, 14), 'Apogee')}
            ${swatch(landingIconSvg(sampleColor, 16), 'Landing')}
            ${lineSwatch('background:repeating-linear-gradient(to right, ' + sampleColor + ' 0 6px, transparent 6px 10px); height:2px;', 'Drift / Descent')}
            ${lineSwatch('background:repeating-linear-gradient(to right, ' + sampleColor + ' 0 2px, transparent 2px 10px); height:3px;', 'Ascent')}
            ${lineSwatch('border:1px dashed ' + sampleColor + '; height:0;', 'Dispersion zone')}
        </div>`;
}

function initMapLegend() {
    const ctrl = L.control({ position: 'bottomleft' });
    ctrl.onAdd = () => {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = buildLegendHtml();
        // Stop map drag/click from firing inside the legend.
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        // Collapse/expand toggle.
        div.addEventListener('click', (e) => {
            const btn = e.target.closest('.legend-toggle');
            if (!btn) return;
            const collapsed = div.classList.toggle('collapsed');
            btn.textContent = collapsed ? '+' : '−';
            btn.title = collapsed ? 'Expand' : 'Collapse';
        });
        return div;
    };
    ctrl.addTo(map);
    mapLegendControl = ctrl;
}
initMapLegend();

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
    renderComparisonTable();
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
    renderComparisonTable();
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

// --- Hard clamp on input (all numeric fields) ---
// Fires on every keystroke/input event, immediately replacing the value
// with the min or max if exceeded. Prevents out-of-range values from
// ever sitting in a field.
// Altitude fields use dynamic limits (imperial/metric); others use static limits.
const ALTITUDE_FIELDS = new Set(['apogee', 'apogeeDual', 'transition']);

function attachInputClamp(input, limKey) {
    let lastClampToast = 0;
    input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        if (isNaN(val)) return;

        // Altitude fields use the unit-aware max.
        let lim = INPUT_LIMITS[limKey];
        let unitSuffix = '';
        if (ALTITUDE_FIELDS.has(limKey)) {
            lim = { ...lim, max: useImperial ? MAX_ALTITUDE_FT : MAX_ALTITUDE_M };
            unitSuffix = useImperial ? ' ft' : ' m';
        }
        if (val > lim.max) {
            input.value = lim.max;
            // Debounce: at most one clamp toast per 1.5s per input
            const now = Date.now();
            if (now - lastClampToast > 1500) {
                lastClampToast = now;
                showToast(
                    `Capped at ${lim.max.toLocaleString()}${unitSuffix} — entered ${val.toLocaleString()}${unitSuffix} exceeds the maximum`,
                    'warning'
                );
            }
        } else if (val < lim.min) {
            input.value = lim.min;
        }
    });
}

// Attach to altitude fields.
attachInputClamp(apogeeInput, 'apogee');
attachInputClamp($('apogee-dual'), 'apogeeDual');
attachInputClamp(transitionInput, 'transition');

// Attach to all other numeric fields.
for (const [domId, limKey] of Object.entries(INPUT_ID_TO_KEY)) {
    const el = $(domId);
    if (el) attachInputClamp(el, limKey);
}

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

// Builds a cache key for wind data based on location and time.
function buildWindCacheKey(lat, lon, dateStr, hh, mm) {
    return `${lat.toFixed(4)}_${lon.toFixed(4)}_${dateStr}_${hh}:${mm}`;
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

// Creates a colored dot icon for landing markers.
function makeLandingIcon(color) {
    return L.divIcon({
        html: landingIconSvg(color),
        className: 'fmr-marker fmr-landing', iconSize: [20, 20], iconAnchor: [10, 20]
    });
}

// Draws map overlays (markers, paths, ellipse) for one scenario into
// a given layer group using the specified color.
function renderMapOverlays(dispersion, color, layerGroup) {
    const { primaryResult, primaryAscentPath, ellipse } = dispersion;

    // Drift path polyline.
    L.polyline(primaryResult.path, {
        color, weight: 2, opacity: 0.7, dashArray: '6,4'
    }).addTo(layerGroup);

    // Landing marker with scenario color.
    L.marker([primaryResult.landingLat, primaryResult.landingLon], { icon: makeLandingIcon(color) })
        .bindTooltip('Landing', { permanent: true, direction: 'top', offset: [0, -10], className: 'fmr-marker-label' })
        .bindPopup('<b>Predicted Landing</b>')
        .addTo(layerGroup);

    // Dispersion ellipse.
    const multiScenario = scenarios.length > 0;
    if (ellipse && ellipse.semiMajor > 0) {
        const pts = createEllipsePoints(
            [ellipse.centerLat, ellipse.centerLon],
            ellipse.semiMajor, ellipse.semiMinor, ellipse.rotation
        );
        L.polygon(pts, {
            color, fillColor: color, fillOpacity: multiScenario ? 0.08 : 0.12,
            weight: 2, dashArray: '4,4'
        }).addTo(layerGroup);
    }

    // Ascent path (if available).
    if (primaryAscentPath && primaryAscentPath.length > 1) {
        L.polyline(primaryAscentPath, {
            color, weight: 3, opacity: 0.85, dashArray: '2,8'
        }).addTo(layerGroup);

        // Directional chevrons at 25/50/75% along the path so the upward
        // direction is unambiguous on the map.
        const chevronFractions = [0.25, 0.5, 0.75];
        for (const f of chevronFractions) {
            const idx = Math.max(1, Math.min(primaryAscentPath.length - 1, Math.floor(primaryAscentPath.length * f)));
            const here = primaryAscentPath[idx];
            const prev = primaryAscentPath[idx - 1];
            // atan2(lon_delta, lat_delta) returns a compass bearing
            // (0=N, 90=E). The upward-pointing SVG chevron is rotated
            // clockwise by that bearing to point in the direction of travel.
            const bearing = Math.atan2(here[1] - prev[1], here[0] - prev[0]) * 180 / Math.PI;
            const chevronIcon = L.divIcon({
                html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" style="transform:rotate(${bearing}deg);filter:drop-shadow(0 0 3px ${color}aa)">
                    <path d="M2 9 L6 3 L10 9" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>`,
                className: 'fmr-marker fmr-chevron', iconSize: [12, 12], iconAnchor: [6, 6],
            });
            L.marker(here, { icon: chevronIcon, interactive: false }).addTo(layerGroup);
        }

        const apogeePoint = primaryAscentPath[primaryAscentPath.length - 1];
        const apogeeIcon = L.divIcon({
            html: apogeeIconSvg(color),
            className: 'fmr-marker fmr-apogee', iconSize: [18, 18], iconAnchor: [9, 9]
        });
        L.marker(apogeePoint, { icon: apogeeIcon })
            .bindTooltip('Apogee', { permanent: true, direction: 'top', offset: [0, -8], className: 'fmr-marker-label' })
            .bindPopup('<b>Apogee</b>')
            .addTo(layerGroup);
    }
}

// Updates the 6 result card DOM elements with values from a dispersion result.
function renderResultCards(dispersion) {
    const { primaryResult, ellipse, forecastTime } = dispersion;

    $('res-landing').textContent =
        `${primaryResult.landingLat.toFixed(5)}, ${primaryResult.landingLon.toFixed(5)}`;

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

    $('res-bearing').textContent =
        `${primaryResult.driftBearing.toFixed(0)}° (${bearingToCompass(primaryResult.driftBearing)})`;

    $('res-time').textContent =
        primaryResult.totalTime < 60
            ? `${primaryResult.totalTime.toFixed(0)} s`
            : `${Math.floor(primaryResult.totalTime / 60)}m ${Math.round(primaryResult.totalTime % 60)}s`;

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

    if (forecastTime) {
        $('res-forecast-time').textContent = forecastTime.toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }
}

// Populates the wind profile table for a given dispersion result.
function renderWindTable(dispersion) {
    const { primaryProfile, apogee } = dispersion;
    const tbody = document.querySelector('#wind-table tbody');
    tbody.innerHTML = '';
    if (primaryProfile) {
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
}

// Redraws map with launch marker + all visible scenario overlays + current result.
function renderAllScenarios() {
    mapLayers.clearLayers();

    // Shared launch marker (always orange).
    const lat = lastLaunchLat;
    const lon = lastLaunchLon;
    if (lat == null || lon == null) return;
    L.marker([lat, lon], { icon: launchIcon })
        .bindTooltip('Launch', { permanent: true, direction: 'top', offset: [0, -22], className: 'fmr-marker-label' })
        .bindPopup('<b>Launch Site</b>')
        .addTo(mapLayers);

    // Draw pinned scenarios that are visible.
    for (const s of scenarios) {
        s.mapLayerGroup.clearLayers();
        if (s.visible) {
            renderMapOverlays(s.dispersion, s.color, s.mapLayerGroup);
            s.mapLayerGroup.addTo(map);
        } else {
            s.mapLayerGroup.remove();
        }
    }

    // Draw current (unsaved) result if visible.
    if (lastDispersion && currentVisible) {
        renderMapOverlays(lastDispersion, '#ff4c29', mapLayers);
    }

    // Fit bounds to all visible overlays.
    const bounds = L.latLngBounds([[lat, lon]]);
    if (lastDispersion && currentVisible) {
        const r = lastDispersion.primaryResult;
        bounds.extend([r.landingLat, r.landingLon]);
        if (lastDispersion.ellipse) {
            createEllipsePoints(
                [lastDispersion.ellipse.centerLat, lastDispersion.ellipse.centerLon],
                lastDispersion.ellipse.semiMajor, lastDispersion.ellipse.semiMinor, lastDispersion.ellipse.rotation
            ).forEach(p => bounds.extend(p));
        }
    }
    for (const s of scenarios) {
        if (!s.visible) continue;
        const r = s.dispersion.primaryResult;
        bounds.extend([r.landingLat, r.landingLon]);
        if (s.dispersion.ellipse) {
            createEllipsePoints(
                [s.dispersion.ellipse.centerLat, s.dispersion.ellipse.centerLon],
                s.dispersion.ellipse.semiMajor, s.dispersion.ellipse.semiMinor, s.dispersion.ellipse.rotation
            ).forEach(p => bounds.extend(p));
        }
    }
    map.fitBounds(bounds.pad(0.3));
}

// Renders all calculation results: map overlays, result cards, and wind table.
function renderResults(dispersion, lat, lon) {
    lastDispersion = dispersion;
    lastLaunchLat = lat;
    lastLaunchLon = lon;

    renderResultCards(dispersion);
    renderWindTable(dispersion);
    renderAllScenarios();

    resultsPanel.hidden = false;
}

// ============================================================
// SCENARIO COMPARISON
// ============================================================

const scenarioBar = $('scenario-bar');
const comparisonPanel = $('comparison-panel');
const comparisonTable = $('comparison-table');
const scenarioNameModal = $('scenario-name-modal');
const scenarioNameInput = $('scenario-name-input');
let scenarioCounter = 0;

// Returns the next available color from the palette.
function nextScenarioColor() {
    const used = new Set(scenarios.map(s => s.color));
    // Skip orange (#ff4c29) — reserved for the current unsaved result.
    for (const c of SCENARIO_COLORS) {
        if (c !== '#ff4c29' && !used.has(c)) return c;
    }
    return SCENARIO_COLORS[1]; // fallback
}

// Opens the name modal and resolves with the entered name (or null if cancelled).
function promptScenarioName() {
    return new Promise(resolve => {
        scenarioCounter++;
        scenarioNameInput.value = `Scenario ${scenarioCounter}`;
        scenarioNameModal.hidden = false;
        scenarioNameInput.focus();
        scenarioNameInput.select();

        function cleanup() {
            scenarioNameModal.hidden = true;
            $('scenario-name-save').removeEventListener('click', onSave);
            $('scenario-name-close').removeEventListener('click', onClose);
            scenarioNameInput.removeEventListener('keydown', onKey);
        }
        function onSave() { cleanup(); resolve(scenarioNameInput.value.trim() || `Scenario ${scenarioCounter}`); }
        function onClose() { cleanup(); resolve(null); }
        function onKey(e) { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onClose(); }

        $('scenario-name-save').addEventListener('click', onSave);
        $('scenario-name-close').addEventListener('click', onClose);
        scenarioNameInput.addEventListener('keydown', onKey);
    });
}

// Pins the current result as a named scenario.
async function pinScenario() {
    if (!lastDispersion) return showToast('Run a calculation first', 'warning');
    if (scenarios.length >= MAX_SCENARIOS - 1) {
        return showToast(`Maximum ${MAX_SCENARIOS - 1} pinned scenarios`, 'warning');
    }

    const name = await promptScenarioName();
    if (!name) return;

    const scenario = {
        id: crypto.randomUUID(),
        name,
        color: nextScenarioColor(),
        visible: true,
        dispersion: lastDispersion,
        launchLat: lastLaunchLat,
        launchLon: lastLaunchLon,
        mapLayerGroup: L.layerGroup(),
        // Snapshot of inputs/UI state so the scenario can be re-loaded for editing.
        formInputs: getCurrentFormInputs(),
        uiState: {
            useImperial,
            massSmallUnit,
            diaSmallUnit,
            use24h,
            dualDeploy,
        },
    };

    scenarios.push(scenario);
    activeScenarioIndex = scenarios.length - 1;
    renderScenarioBar();
    renderComparisonTable();
    renderAllScenarios();
    showToast(`Pinned "${name}"`, 'info');
}

// Removes a pinned scenario by ID.
function removeScenario(id) {
    const idx = scenarios.findIndex(s => s.id === id);
    if (idx === -1) return;
    scenarios[idx].mapLayerGroup.remove();
    scenarios.splice(idx, 1);
    if (activeScenarioIndex >= scenarios.length) activeScenarioIndex = scenarios.length - 1;
    renderScenarioBar();
    renderComparisonTable();
    renderAllScenarios();
}

// Toggles map overlay visibility for a scenario.
function toggleScenarioVisibility(id) {
    const s = scenarios.find(s => s.id === id);
    if (!s) return;
    s.visible = !s.visible;
    if (s.visible) {
        s.mapLayerGroup.addTo(map);
    } else {
        s.mapLayerGroup.remove();
    }
    renderScenarioBar();
    renderAllScenarios();
}

// Selects a scenario to show its result cards and wind table.
function selectScenario(index) {
    activeScenarioIndex = index;
    if (index >= 0 && index < scenarios.length) {
        renderResultCards(scenarios[index].dispersion);
        renderWindTable(scenarios[index].dispersion);
    } else if (lastDispersion) {
        renderResultCards(lastDispersion);
        renderWindTable(lastDispersion);
    }
    renderScenarioBar();
}

// Loads a scenario's saved inputs back into the form so the user can
// tweak values and re-run the calculation. Older scenarios pinned before
// input snapshotting was added won't have formInputs.
function editScenario(id) {
    const s = scenarios.find(x => x.id === id);
    if (!s) return;
    if (!s.formInputs) {
        showToast('This scenario was pinned before input editing was supported', 'warning');
        return;
    }

    // Restore unit/format toggles before applying values, so values land in the right unit.
    const ui = s.uiState || {};
    if (ui.useImperial != null && ui.useImperial !== useImperial) {
        (ui.useImperial ? imperialBtn : metricBtn).click();
    }
    if (ui.use24h != null && ui.use24h !== use24h) {
        timeFormatLabel.click();
    }
    // Deploy mode toggle (its click handler is a no-op when already in target state).
    const wantDual = !!ui.dualDeploy;
    if (wantDual && !dualDeploy) modeDualBtn.click();
    else if (!wantDual && dualDeploy) modeSingleBtn.click();

    applyFormInputs(s.formInputs);

    // Restore the launch pin and azimuth compass.
    if (s.launchLat != null && s.launchLon != null) {
        updatePinPosition(s.launchLat, s.launchLon);
    }
    const azVal = parseFloat(s.formInputs.launchAzimuth);
    if (!isNaN(azVal)) {
        const compass = $('azimuth-compass');
        if (compass) compass.style.transform = `rotate(${azVal}deg)`;
    }

    // Bring the calculate button into view so the next action is obvious.
    const calcBtn = $('calc-btn');
    if (calcBtn) calcBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

    showToast(`Loaded "${s.name}" inputs — click Calculate to re-run`, 'info');
    dismissScenarioHint();
}

// Eye icon SVGs.
const EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

// One-time hint shown above the scenario bar to teach chip controls.
const SCENARIO_HINT_KEY = 'scenarioHintDismissed';
function dismissScenarioHint() {
    try { localStorage.setItem(SCENARIO_HINT_KEY, '1'); } catch (e) { /* ignore */ }
    renderScenarioBar();
}
function isScenarioHintDismissed() {
    try { return localStorage.getItem(SCENARIO_HINT_KEY) === '1'; } catch (e) { return false; }
}

// Renders the scenario bar with chips.
function renderScenarioBar() {
    if (scenarios.length === 0) {
        scenarioBar.hidden = true;
        return;
    }
    scenarioBar.hidden = false;
    scenarioBar.innerHTML = '';

    // One-time discoverability hint above the chips.
    if (!isScenarioHintDismissed()) {
        const hint = document.createElement('div');
        hint.className = 'scenario-hint';
        hint.innerHTML = 'Click a chip to view results · <span class="hint-icon">✎</span> edit inputs · <span class="hint-icon">👁</span> toggle on map <button class="hint-dismiss" title="Dismiss">&times;</button>';
        hint.querySelector('.hint-dismiss').addEventListener('click', dismissScenarioHint);
        scenarioBar.appendChild(hint);
    }

    // "Current" chip
    const currentChip = document.createElement('div');
    currentChip.className = `scenario-chip${activeScenarioIndex === -1 ? ' active' : ''}${!currentVisible ? ' hidden-scenario' : ''}`;
    currentChip.innerHTML = `
        <span class="scenario-dot" style="background:#ff4c29"></span>
        <span class="scenario-name">Current</span>
        <button class="eye-btn" title="${currentVisible ? 'Hide' : 'Show'} on map">${currentVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG}</button>
    `;
    currentChip.addEventListener('click', (e) => {
        if (e.target.closest('.eye-btn')) return;
        selectScenario(-1);
    });
    currentChip.querySelector('.eye-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        currentVisible = !currentVisible;
        renderScenarioBar();
        renderAllScenarios();
    });
    scenarioBar.appendChild(currentChip);

    // Pinned scenario chips
    scenarios.forEach((s, i) => {
        const chip = document.createElement('div');
        chip.className = `scenario-chip${activeScenarioIndex === i ? ' active' : ''}${!s.visible ? ' hidden-scenario' : ''}`;
        chip.innerHTML = `
            <span class="scenario-dot" style="background:${s.color}"></span>
            <span class="scenario-name">${s.name}</span>
            <button class="edit-btn" title="Edit inputs (load into form)">${PENCIL_SVG}</button>
            <button class="eye-btn" title="${s.visible ? 'Hide' : 'Show'} on map">${s.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG}</button>
            <button class="remove-btn" title="Remove">&times;</button>
        `;

        // Click chip body to select.
        chip.addEventListener('click', (e) => {
            if (e.target.closest('.edit-btn') || e.target.closest('.eye-btn') || e.target.closest('.remove-btn')) return;
            selectScenario(i);
            dismissScenarioHint();
        });

        // Edit (load inputs into form).
        chip.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            editScenario(s.id);
        });

        // Eye toggle.
        chip.querySelector('.eye-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleScenarioVisibility(s.id);
            dismissScenarioHint();
        });

        // Remove button.
        chip.querySelector('.remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            removeScenario(s.id);
        });

        scenarioBar.appendChild(chip);
    });
}

// Formats a dispersion result value for the comparison table.
function formatComparisonValue(dispersion, metric) {
    const { primaryResult, ellipse, forecastTime } = dispersion;
    switch (metric) {
        case 'landing':
            return `${primaryResult.landingLat.toFixed(5)}, ${primaryResult.landingLon.toFixed(5)}`;
        case 'distance': {
            const dist = primaryResult.driftDistance;
            if (useImperial) {
                const distFt = dist * FT_PER_M;
                return distFt < 5280 ? `${distFt.toFixed(0)} ft` : `${(distFt / 5280).toFixed(2)} mi`;
            }
            return dist < 1000 ? `${dist.toFixed(0)} m` : `${(dist / 1000).toFixed(2)} km`;
        }
        case 'bearing':
            return `${primaryResult.driftBearing.toFixed(0)}° (${bearingToCompass(primaryResult.driftBearing)})`;
        case 'time':
            return primaryResult.totalTime < 60
                ? `${primaryResult.totalTime.toFixed(0)} s`
                : `${Math.floor(primaryResult.totalTime / 60)}m ${Math.round(primaryResult.totalTime % 60)}s`;
        case 'dispersion':
            if (!ellipse) return '—';
            if (useImperial) return `${Math.round(ellipse.semiMajor * 2 * FT_PER_M)} x ${Math.round(ellipse.semiMinor * 2 * FT_PER_M)} ft`;
            return `${Math.round(ellipse.semiMajor * 2)} x ${Math.round(ellipse.semiMinor * 2)} m`;
        case 'forecast':
            return forecastTime ? forecastTime.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        default: return '—';
    }
}

// Builds the comparison table from all pinned scenarios + current result.
function renderComparisonTable() {
    if (scenarios.length === 0) {
        comparisonPanel.hidden = true;
        return;
    }
    comparisonPanel.hidden = false;

    const metrics = [
        { key: 'landing', label: 'Landing' },
        { key: 'distance', label: 'Drift Distance' },
        { key: 'bearing', label: 'Bearing' },
        { key: 'time', label: 'Descent Time' },
        { key: 'dispersion', label: 'Dispersion' },
        { key: 'forecast', label: 'Forecast Time' },
    ];

    // Build columns: current + pinned scenarios.
    const columns = [];
    if (lastDispersion) columns.push({ name: 'Current', color: '#ff4c29', dispersion: lastDispersion });
    for (const s of scenarios) columns.push({ name: s.name, color: s.color, dispersion: s.dispersion });

    let html = '<thead><tr><th></th>';
    for (const col of columns) {
        html += `<th><span class="col-dot" style="background:${col.color}"></span>${col.name}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const m of metrics) {
        html += `<tr><td>${m.label}</td>`;
        for (const col of columns) {
            html += `<td>${formatComparisonValue(col.dispersion, m.key)}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody>';
    comparisonTable.innerHTML = html;
}

// Pin scenario button handler.
$('pin-scenario-btn').addEventListener('click', pinScenario);

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
    let hourVal = parseInt(launchHourSelect.value, 10);
    const minVal = parseInt(launchMinSelect.value, 10);
    // Convert 12h to 24h if needed
    if (!use24h) {
        const isPM = launchAmpmSelect.value === 'PM';
        if (hourVal === 12) hourVal = isPM ? 12 : 0;
        else if (isPM) hourVal += 12;
    }
    const hh = String(hourVal).padStart(2, '0');
    const mm = String(minVal).padStart(2, '0');
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
        const enteredDisp = useImperial
            ? `${Math.round(apogee * FT_PER_M).toLocaleString()} ft`
            : `${Math.round(apogee).toLocaleString()} m`;
        return showError(`Altitude ${enteredDisp} exceeds the maximum of ${maxDisp} — limited by available wind data`);
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
        // Check wind data cache before making an API call.
        const cacheKey = buildWindCacheKey(lat, lon, launchDateVal, hh, mm);
        let apiData;
        const cached = windDataCache.get(cacheKey);
        if (cached) {
            apiData = cached.apiData;
            isHistoricalData = cached.isHistorical;
            showToast('Reusing cached wind data', 'info');
        } else {
            apiData = await fetchWindData(lat, lon, launchTime);
            windDataCache.set(cacheKey, { apiData, isHistorical: isHistoricalData });
        }
        if (isHistoricalData) {
            showToast('Historical date — using surface wind extrapolation (less accurate above 100m)', 'warning');
        }
        const orkProfile = orkFlightData ? orkFlightData.ascentProfile : null;
        const dispersion = calculateDispersion(apiData, apogee, transition, dr1, dr2, lat, lon, launchTime, isHistoricalData,
                                                launchAngle, launchAzimuth, ascentRate, orkProfile,
                                                orkWeathercockA, orkWeathercockB);
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
// Stored parsed .ork XML doc and motor configs for config switching.
let orkParsedDoc = null;
let orkMotorConfigs = [];
// Weather-cocking state extracted from the active simulation (see calc.js
// for definitions). orkWeathercockA: per-step (time, altitude, V) profile
// for the NASA tan(θ)=w/V formula. orkWeathercockB: pre-computed back-fit
// coefficients from ORK's recorded apogee position.
let orkWeathercockA = null;
let orkWeathercockB = null;

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
        const result = await parseOrkFile(file);
        orkParsedDoc = result.doc;
        orkMotorConfigs = result.motorConfigs;
        applyOrkData(result.orkData);
        renderMotorConfigSelector();
        showToast(`Imported: ${result.orkData.rocketName}`);
    } catch (err) {
        console.error('ORK import error:', err);
        showToast(err.message || 'Failed to parse .ork file', 'error');
    }
    orkFileInput.value = '';
});

// Parses an .ork file (ZIP archive containing rocket.ork XML).
// Returns { doc, motorConfigs, orkData } so callers can switch configs later.
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

    const motorConfigs = extractAllMotorConfigs(doc);
    const orkData = extractOrkData(doc);
    return { doc, motorConfigs, orkData };
}

// Extracts all motor configurations from the OpenRocket XML DOM.
// Returns an array of { configId, designation, manufacturer, label, isDefault }.
function extractAllMotorConfigs(doc) {
    const configs = [];
    const motorConfigEls = doc.querySelectorAll('motorconfiguration');
    for (const mc of motorConfigEls) {
        const configId = mc.getAttribute('configid');
        if (!configId) continue;
        const isDefault = mc.getAttribute('default') === 'true';

        // Find the matching motor element for this config.
        const motor = doc.querySelector(`motor[configid="${configId}"]`);
        let designation = '';
        let manufacturer = '';
        if (motor) {
            designation = motor.querySelector('designation')?.textContent?.trim() || '';
            manufacturer = motor.querySelector('manufacturer')?.textContent?.trim() || '';
        }
        const label = manufacturer ? `${manufacturer} ${designation}` : designation || configId;
        configs.push({ configId, designation, manufacturer, label, isDefault });
    }
    return configs;
}

// OpenRocket XML stores winddirection in radians but launchrodangle and
// launchroddirection in degrees on the audited fixtures. Auto-detect by
// magnitude: a launch rod tilt > π/2 rad (90°) is physically implausible,
// and a launch rod direction > 2π rad means the value can't be radians.
function autoDetectAngleRad(val, isDirection) {
    if (isNaN(val)) return 0;
    const threshold = isDirection ? 6.3 : 1.5;
    return val > threshold ? val * (Math.PI / 180) : val;
}

// Builds the weathercockB state object from ORK's recorded apogee position.
// Subtracts the rod-tilt baseline so the back-fit coefficient reflects only
// the wind-dependent portion of the offset, then computes per-axis (along/cross)
// coefficients in ORK's wind frame.
function buildWeathercockB(params) {
    const {
        apogeePosEast, apogeePosNorth, apogeeAlt, ascentProfile,
        orkWindSpeed, orkWindDirRad, orkRodAngleRad, orkRodDirRad,
    } = params;

    // Subtract ORK's rod-tilt baseline. computeRodTiltOffset takes degrees.
    let baselineEast = 0, baselineNorth = 0;
    if (orkRodAngleRad > 0) {
        const baseline = computeRodTiltOffset(
            orkRodAngleRad * (180 / Math.PI),
            orkRodDirRad * (180 / Math.PI),
            apogeeAlt,
            ascentProfile,
            0
        );
        baselineEast = baseline.dx;
        baselineNorth = baseline.dy;
    }
    const windEast = apogeePosEast - baselineEast;
    const windNorth = apogeePosNorth - baselineNorth;

    // Wind FROM-direction. Prefer explicit; else derive from the wind-induced
    // offset (rocket weathercocks INTO the wind, so wind FROM-direction equals
    // the geographic direction from pad to apogee).
    let windDirRad;
    let windDirSource;
    if (orkWindDirRad != null) {
        windDirRad = orkWindDirRad;
        windDirSource = 'explicit';
    } else if (Math.hypot(windEast, windNorth) > 0.5) {
        windDirRad = Math.atan2(windEast, windNorth);
        windDirSource = 'derived';
    } else {
        windDirRad = 0;
        windDirSource = 'unknown';
    }
    windDirRad = ((windDirRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // Decompose wind-induced offset into ORK wind frame: along = FROM-direction,
    // cross = perpendicular (clockwise when viewed from above).
    const alongEast = Math.sin(windDirRad);
    const alongNorth = Math.cos(windDirRad);
    const crossEast = Math.cos(windDirRad);
    const crossNorth = -Math.sin(windDirRad);
    const offsetAlong = windEast * alongEast + windNorth * alongNorth;
    const offsetCross = windEast * crossEast + windNorth * crossNorth;

    let coeffAlong = 0, coeffCross = 0;
    if (orkWindSpeed > 0.01) {
        coeffAlong = offsetAlong / orkWindSpeed;
        coeffCross = offsetCross / orkWindSpeed;
    }

    return {
        apogeePosEast, apogeePosNorth,
        orkWindSpeed,
        orkWindDirRad: windDirRad,
        windDirSource,
        orkRodAngleRad,
        coeffAlong, coeffCross,
        fallbackOffset: { dx: apogeePosEast, dy: apogeePosNorth },
    };
}

// Walks the OpenRocket XML DOM and extracts rocket info, recovery
// devices, motor designation, mass, and simulation data.
// If selectedConfigId is provided, uses that motor config instead of the default.
function extractOrkData(doc, selectedConfigId) {
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

    // Motor designation: use selected config or fall back to default.
    const configId = selectedConfigId
        || doc.querySelector('motorconfiguration[default="true"]')?.getAttribute('configid')
        || null;
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
    // Treat "ejection" the same as "apogee" (motor ejection charge at apogee).
    const apogeeChutes = result.parachutes.filter(p => p.deployEvent === 'apogee' || p.deployEvent === 'ejection');
    const altitudeChutes = result.parachutes.filter(p => p.deployEvent === 'altitude');
    if (apogeeChutes.length > 0 && altitudeChutes.length > 0) {
        result.isDualDeploy = true;
    }

    // Simulation selection. Validate that the simulation has actual datapoints
    // (not just a flightdata attribute block — Der Flammenwallet has those
    // without any databranch). Preference order:
    //   configId match → uptodate → loaded → outdated → reject.
    const sims = doc.querySelectorAll('simulation');
    const simHasUsableData = (sim) => {
        const fd = sim.querySelector('flightdata');
        if (!fd) return false;
        const branch = fd.querySelector('databranch');
        if (!branch) return false;
        return branch.querySelectorAll('datapoint').length > 0;
    };
    const findByPreference = (preferredStatuses, requireConfigId) => {
        for (const sim of sims) {
            if (requireConfigId) {
                const simConfigEl = sim.querySelector('configid');
                if (!simConfigEl || simConfigEl.textContent.trim() !== configId) continue;
            }
            const status = sim.getAttribute('status');
            if (!preferredStatuses.includes(status)) continue;
            if (simHasUsableData(sim)) return sim;
        }
        return null;
    };
    let bestSim = null;
    if (configId) {
        bestSim = findByPreference(['uptodate', 'loaded', 'outdated'], true);
    }
    if (!bestSim) bestSim = findByPreference(['uptodate'], false);
    if (!bestSim) bestSim = findByPreference(['loaded'], false);
    if (!bestSim) bestSim = findByPreference(['outdated'], false);
    // Absolute fallback for files where status is missing entirely.
    if (!bestSim) {
        for (const sim of sims) {
            if (simHasUsableData(sim)) { bestSim = sim; break; }
        }
    }
    // Last resort: first sim, even without usable data — for the maxaltitude
    // attribute fallback path below.
    if (!bestSim && sims.length > 0) bestSim = sims[0];

    if (bestSim) {
        const fd = bestSim.querySelector('flightdata');
        if (fd) {
            const maxAlt = parseFloat(fd.getAttribute('maxaltitude'));
            if (!isNaN(maxAlt)) result.deploymentAltitude = maxAlt;

            // Read launch conditions for weather-cocking baseline subtraction.
            // We DO NOT read launchlatitude/launchlongitude — those are template
            // defaults (28.61, -80.6) in every audited fixture file.
            const conds = bestSim.querySelector('conditions');
            const orkWindSpeed = parseFloat(conds?.querySelector('windaverage')?.textContent);
            const orkWindDirRadRaw = parseFloat(conds?.querySelector('winddirection')?.textContent);
            const orkRodAngleRad = autoDetectAngleRad(parseFloat(conds?.querySelector('launchrodangle')?.textContent), false);
            const orkRodDirRad = autoDetectAngleRad(parseFloat(conds?.querySelector('launchroddirection')?.textContent), true);

            const branch = fd.querySelector('databranch');
            if (branch) {
                const typesStr = branch.getAttribute('types') || '';
                const types = typesStr.split(',');
                const massIdx = types.indexOf('Mass');
                const altIdx = types.indexOf('Altitude');
                const timeIdx = types.indexOf('Time');
                const vvelIdx = types.indexOf('Vertical velocity');
                const posEastIdx = types.indexOf('Position East of launch');
                const posNorthIdx = types.indexOf('Position North of launch');

                const datapoints = branch.querySelectorAll('datapoint');
                if (datapoints.length > 0 && massIdx >= 0) {
                    const firstVals = datapoints[0].textContent.trim().split(/\s*,\s*/);
                    const mass = parseFloat(firstVals[massIdx]);
                    if (!isNaN(mass) && mass > 0) result.totalMass = mass;
                }

                // Walk all datapoints, capturing what's available per row.
                // Apogee is the global argmax of altitude (NOT first decrease —
                // that's booster-burnout altitude on multistage rockets).
                if (timeIdx >= 0 && altIdx >= 0 && datapoints.length > 0) {
                    const allRows = [];
                    for (const dp of datapoints) {
                        const vals = dp.textContent.trim().split(/\s*,\s*/);
                        const time = parseFloat(vals[timeIdx]);
                        const alt = parseFloat(vals[altIdx]);
                        if (isNaN(time) || isNaN(alt)) continue;
                        const row = { time, altitude: alt };
                        if (vvelIdx >= 0) {
                            const v = parseFloat(vals[vvelIdx]);
                            if (!isNaN(v)) row.V = v;
                        }
                        if (posEastIdx >= 0) {
                            const e = parseFloat(vals[posEastIdx]);
                            if (!isNaN(e)) row.posEast = e;
                        }
                        if (posNorthIdx >= 0) {
                            const n = parseFloat(vals[posNorthIdx]);
                            if (!isNaN(n)) row.posNorth = n;
                        }
                        allRows.push(row);
                    }

                    // Find the global apogee.
                    let apogeeIdx = 0;
                    for (let i = 1; i < allRows.length; i++) {
                        if (allRows[i].altitude > allRows[apogeeIdx].altitude) apogeeIdx = i;
                    }
                    const ascentRows = allRows.slice(0, apogeeIdx + 1);
                    if (ascentRows.length > 2) {
                        result.simulationData = {
                            ascentProfile: ascentRows.map(r => ({ time: r.time, altitude: r.altitude }))
                        };

                        // Build weathercockA: per-step (time, altitude, V) for the formula.
                        if (vvelIdx >= 0 && ascentRows.every(r => r.V !== undefined)) {
                            result.weathercockA = {
                                profile: ascentRows.map(r => ({ time: r.time, altitude: r.altitude, V: r.V }))
                            };
                        }

                        // Build weathercockB: back-fit from recorded apogee position.
                        const apogeeRow = ascentRows[ascentRows.length - 1];
                        if (apogeeRow.posEast !== undefined && apogeeRow.posNorth !== undefined) {
                            result.weathercockB = buildWeathercockB({
                                apogeePosEast: apogeeRow.posEast,
                                apogeePosNorth: apogeeRow.posNorth,
                                apogeeAlt: apogeeRow.altitude,
                                ascentProfile: result.simulationData.ascentProfile,
                                orkWindSpeed: isNaN(orkWindSpeed) ? 0 : orkWindSpeed,
                                orkWindDirRad: isNaN(orkWindDirRadRaw) ? null : orkWindDirRadRaw,
                                orkRodAngleRad: isNaN(orkRodAngleRad) ? 0 : orkRodAngleRad,
                                orkRodDirRad: isNaN(orkRodDirRad) ? 0 : orkRodDirRad,
                            });
                        }
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

            // Fallback: if no detailed datapoints, derive average ascent rate
            // from flightdata summary attributes (maxaltitude & timetoapogee).
            if (!result.simulationData) {
                const summaryAlt = parseFloat(fd.getAttribute('maxaltitude'));
                const summaryTime = parseFloat(fd.getAttribute('timetoapogee'));
                if (!isNaN(summaryAlt) && !isNaN(summaryTime) && summaryTime > 0 && summaryAlt > 0) {
                    result.summaryAscentRate = summaryAlt / summaryTime; // m/s
                }
            }

            // Fallback: if no mass from datapoints, use groundhitvelocity as
            // the descent rate directly (avoids needing mass for chute calc).
            if (!result.totalMass) {
                const groundHitVel = parseFloat(fd.getAttribute('groundhitvelocity'));
                if (!isNaN(groundHitVel) && groundHitVel > 0) {
                    result.summaryDescentRate = groundHitVel; // m/s
                }
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

    // Store simulation data for ascent visualization, plus weather-cocking
    // state (A: NASA formula profile, B: ORK back-fit coefficients).
    orkFlightData = orkData.simulationData;
    orkWeathercockA = orkData.weathercockA || null;
    orkWeathercockB = orkData.weathercockB || null;
    renderWeathercockInfo(orkData);

    if (orkData.isDualDeploy) {
        // Switch to dual deploy mode.
        if (!dualDeploy) modeDualBtn.click();

        const drogue = orkData.parachutes.find(p => p.deployEvent === 'apogee' || p.deployEvent === 'ejection');
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
        const dr1Hint = $('dr1-hint');
        if (chute && orkData.totalMass) {
            const dr = calcDescentRate(orkData.totalMass, chute.diameter, chute.cd);
            dr1Input.value = useImperial ? (dr * FPS_PER_MS).toFixed(1) : dr.toFixed(1);
            markAutoFilled(dr1Input);
            dr1Hint.textContent = 'Calculated from .ork chute diameter, Cd, and mass.';
            dr1Hint.classList.add('ork-active');
        } else if (orkData.summaryDescentRate) {
            const dr = orkData.summaryDescentRate;
            dr1Input.value = useImperial ? (dr * FPS_PER_MS).toFixed(1) : dr.toFixed(1);
            markAutoFilled(dr1Input);
            dr1Hint.textContent = 'Estimated from .ork ground hit velocity. Run simulation in OpenRocket for higher accuracy.';
            dr1Hint.classList.add('ork-active');
            showToast('Descent rate estimated from .ork flight summary (ground hit velocity). Run simulation in OpenRocket for higher accuracy.', 'warning');
        } else {
            dr1Hint.textContent = '';
            dr1Hint.classList.remove('ork-active');
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
    } else if (orkData.summaryAscentRate) {
        // Fallback: use average ascent rate derived from flightdata summary.
        const avgRate = orkData.summaryAscentRate; // m/s
        ascentRateInput.value = useImperial
            ? (avgRate * FPS_PER_MS).toFixed(1)
            : avgRate.toFixed(1);
        markAutoFilled(ascentRateInput);
        ascentHint.textContent = 'Estimated from .ork summary (no detailed sim data). Run simulation in OpenRocket for higher accuracy.';
        ascentHint.classList.add('ork-active');
        showToast('Simulation not run in OpenRocket — using estimated average ascent rate from flight summary.', 'warning');
    } else {
        ascentHint.textContent = 'Average vertical speed to apogee. Import a .ork file for accurate per-step timing.';
        ascentHint.classList.remove('ork-active');
    }

    orkSummary.hidden = false;

    if (!orkData.simulationData && !orkData.summaryAscentRate) {
        showToast('No simulation data — ascent path not available', 'warning');
    }
    if (!orkData.totalMass) {
        showToast('Mass not found — use the Descent Rate Calculator', 'warning');
    }
}

// Renders the weather-cocking info card. Surfaces which approach (A or B)
// will be used and a sample magnitude so the user can sanity-check at a
// glance without running the dispersion. Hidden when neither A nor B exist.
function renderWeathercockInfo(orkData) {
    const el = $('weathercock-info');
    if (!el) return;
    const wcB = orkData.weathercockB;
    const wcA = orkData.weathercockA;
    if (!wcB && !wcA) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    const lines = [];
    if (wcB) {
        const totalOffset = Math.hypot(wcB.apogeePosEast, wcB.apogeePosNorth);
        const offsetDisp = useImperial
            ? `${(totalOffset * FT_PER_M).toFixed(0)} ft`
            : `${totalOffset.toFixed(0)} m`;
        const windDisp = useImperial
            ? `${(wcB.orkWindSpeed * MPH_PER_MS).toFixed(1)} mph`
            : `${wcB.orkWindSpeed.toFixed(1)} m/s`;
        const dirNote = wcB.windDirSource === 'derived' ? ' (direction derived from offset)' : '';
        lines.push(`Weather cocking from ORK: ${offsetDisp} apogee offset @ ${windDisp} ORK wind${dirNote}. Will scale to live wind.`);
    } else if (wcA) {
        lines.push('Weather cocking will be computed from ORK vertical-velocity profile using NASA tan(θ)=w/V formula.');
    }
    el.textContent = lines.join(' ');
    el.hidden = false;
}

// Clear .ork import.
$('ork-clear-btn').addEventListener('click', () => {
    orkSummary.hidden = true;
    orkFlightData = null;
    orkParsedDoc = null;
    orkMotorConfigs = [];
    orkWeathercockA = null;
    orkWeathercockB = null;
    const wcInfo = $('weathercock-info');
    if (wcInfo) { wcInfo.hidden = true; wcInfo.textContent = ''; }
    clearAutoFilled();
    const ascentHint = $('ascent-rate-hint');
    ascentHint.textContent = 'Average vertical speed to apogee. Import a .ork file for accurate per-step timing.';
    ascentHint.classList.remove('ork-active');
    showToast('Import cleared');
});

// Renders the motor config dropdown if the .ork has multiple configs.
function renderMotorConfigSelector() {
    const row = $('ork-motor-config-row');
    const select = $('ork-motor-select');
    if (orkMotorConfigs.length <= 1) {
        row.hidden = true;
        return;
    }
    select.innerHTML = '';
    for (const cfg of orkMotorConfigs) {
        const opt = document.createElement('option');
        opt.value = cfg.configId;
        opt.textContent = cfg.label;
        if (cfg.isDefault) opt.selected = true;
        select.appendChild(opt);
    }
    row.hidden = false;
}

// Switch motor config when the user selects a different one.
$('ork-motor-select').addEventListener('change', (e) => {
    if (!orkParsedDoc) return;
    const selectedConfigId = e.target.value;
    clearAutoFilled();
    const orkData = extractOrkData(orkParsedDoc, selectedConfigId);
    applyOrkData(orkData);
    showToast(`Switched to ${orkData.motorDesignation}`);
});

// ============================================================
// DESCENT RATE CALCULATOR
// ============================================================

// Computes the descent rate and optionally applies it to a target field.
// Returns the computed rate string (or null if inputs are invalid).
function computeDR() {
    let mass = parseFloat($('calc-mass').value);
    let diameter = parseFloat($('calc-diameter').value);
    const cd = parseFloat($('calc-cd').value);

    if (isNaN(mass) || isNaN(diameter) || isNaN(cd) || mass <= 0 || diameter <= 0 || cd <= 0) {
        $('calc-result').textContent = '—';
        return null;
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

    return useImperial ? (descentRate * FPS_PER_MS).toFixed(1) : descentRate.toFixed(1);
}

// Apply a computed rate to a specific target field.
function applyDR(targetField) {
    const rateValue = computeDR();
    if (rateValue == null) {
        showToast('Enter valid mass, diameter, and Cd', 'error');
        return;
    }
    targetField.value = rateValue;
    markAutoFilled(targetField);
}

// Live-update: recalculate on every input change, auto-apply in single deploy mode.
function onCalcInput() {
    const rateValue = computeDR();
    if (rateValue != null && !dualDeploy) {
        dr1Input.value = rateValue;
        markAutoFilled(dr1Input);
    }
}

$('calc-mass').addEventListener('input', onCalcInput);
$('calc-diameter').addEventListener('input', onCalcInput);
$('calc-cd').addEventListener('input', onCalcInput);

// Show/hide the correct apply buttons based on deploy mode.
// In single mode, hide all buttons (auto-apply handles it).
// In dual mode, show drogue & main buttons so user picks which to apply.
function updateCalcButtons() {
    $('calc-apply-single').hidden = true;
    $('calc-apply-drogue').hidden = !dualDeploy;
    $('calc-apply-main').hidden = !dualDeploy;
    // Hide the entire actions container in single deploy mode
    $('calc-apply-drogue').parentElement.hidden = !dualDeploy;
}
updateCalcButtons();

$('calc-apply-single').addEventListener('click', () => applyDR(dr1Input));
$('calc-apply-drogue').addEventListener('click', () => applyDR(dr1DualInput));
$('calc-apply-main').addEventListener('click', () => applyDR(dr2Input));

// Update calc buttons when deploy mode changes; re-run live calc.
modeSingleBtn.addEventListener('click', () => { updateCalcButtons(); onCalcInput(); });
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

    // Hide the draggable launch pin — its SVG would render twice on top of
    // the small launch marker. The small marker alone represents the launch
    // location in the export. Restored in finally below.
    const pinEl = launchPin && launchPin._icon;
    const prevPinDisplay = pinEl ? pinEl.style.display : null;
    if (pinEl) pinEl.style.display = 'none';
    try {

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

    // --- Draw markers ---
    // Each marker icon is either an inline <svg> (the new typed icons) or
    // a styled colored <div> (legacy / arrow chevrons). For SVGs we serialize
    // and rasterize via Image; for divs we draw a circle.
    const markerPane = mapEl.querySelector('.leaflet-marker-pane');
    if (markerPane) {
        const markerJobs = [];
        markerPane.querySelectorAll('.leaflet-marker-icon').forEach(marker => {
            // Skip the draggable launch pin — the small launchIcon already
            // represents the launch site. Without this, both render together.
            if (marker === pinEl) return;
            const [mx, my] = parseTranslate3d(marker);
            const svg = marker.querySelector('svg');
            if (svg) {
                const w = parseFloat(svg.getAttribute('width')) || marker.offsetWidth || 18;
                const h = parseFloat(svg.getAttribute('height')) || marker.offsetHeight || w;
                const svgData = new XMLSerializer().serializeToString(svg);
                const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                markerJobs.push(new Promise(resolve => {
                    const img = new Image();
                    img.onload = () => {
                        ctx.drawImage(img, px + mx, py + my, w, h);
                        URL.revokeObjectURL(url);
                        resolve();
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
                    img.src = url;
                }));
            } else {
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
            }
        });
        await Promise.all(markerJobs);
    }

    // --- Draw permanent tooltips (Launch / Apogee / Landing labels) ---
    const tooltipPane = mapEl.querySelector('.leaflet-tooltip-pane');
    if (tooltipPane) {
        tooltipPane.querySelectorAll('.leaflet-tooltip').forEach(tip => {
            const [tx, ty] = parseTranslate3d(tip);
            const text = tip.textContent || '';
            if (!text) return;
            ctx.font = '600 11px system-ui, -apple-system, sans-serif';
            const padX = 6, padY = 2;
            const metrics = ctx.measureText(text);
            const w = Math.ceil(metrics.width) + padX * 2;
            const h = 16;
            ctx.fillStyle = 'rgba(15,15,20,0.78)';
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(px + tx, py + ty, w, h, 4) : ctx.rect(px + tx, py + ty, w, h);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, px + tx + padX, py + ty + h / 2 + 1);
        });
    }

    return canvas.toDataURL('image/png');
    } finally {
        if (pinEl) pinEl.style.display = prevPinDisplay || '';
    }
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
        comparison: $('exp-comparison').checked,
        calculations: $('exp-calculations').checked,
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

    // Build scenario comparison table HTML if requested and scenarios exist.
    let comparisonHtml = '';
    if (checks.comparison && scenarios.length > 0) {
        const metrics = [
            { key: 'landing', label: 'Landing' },
            { key: 'distance', label: 'Drift Distance' },
            { key: 'bearing', label: 'Bearing' },
            { key: 'time', label: 'Descent Time' },
            { key: 'dispersion', label: 'Dispersion' },
            { key: 'forecast', label: 'Forecast Time' },
        ];
        const cols = [];
        if (lastDispersion) cols.push({ name: 'Current', color: '#ff4c29', dispersion: lastDispersion });
        for (const s of scenarios) cols.push({ name: s.name, color: s.color, dispersion: s.dispersion });

        let ths = '<th style="text-align:left;padding:4px 8px;color:#888"></th>';
        for (const col of cols) {
            ths += `<th style="text-align:center;padding:4px 8px;color:#888;font-size:11px;text-transform:uppercase"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col.color};margin-right:4px;vertical-align:middle"></span>${col.name}</th>`;
        }
        let trs = '';
        for (const m of metrics) {
            trs += `<tr><td style="padding:4px 8px;color:#888;font-size:11px;text-transform:uppercase;border-bottom:1px solid #1a2236">${m.label}</td>`;
            for (const col of cols) {
                trs += `<td style="padding:4px 8px;text-align:center;font-family:Consolas,monospace;font-size:12px;border-bottom:1px solid #1a2236">${formatComparisonValue(col.dispersion, m.key)}</td>`;
            }
            trs += '</tr>';
        }
        comparisonHtml = `
            <h3 style="margin:16px 0 6px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.5px">Scenario Comparison</h3>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
                <thead><tr style="border-bottom:2px solid #333">${ths}</tr></thead>
                <tbody>${trs}</tbody>
            </table>`;
    }

    // Build the calculation-details section if requested.
    let calculationsHtml = '';
    if (checks.calculations) {
        try {
            calculationsHtml = buildCalculationDetailsHtml();
        } catch (err) {
            console.error('Calculation details build failed:', err);
            calculationsHtml = '';
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
    ${mapDataUrl ? buildExportLegendHtml() : ''}
    <div class="data-grid">${dataRows}</div>
    ${comparisonHtml}
    ${calculationsHtml}
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

// Inline-styled legend rendered into the export report alongside the map image.
function buildExportLegendHtml() {
    const sample = '#4dd2ff';
    const cell = (icon, label) =>
        `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#e0e6f0">
            <span style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center">${icon}</span>
            <span>${label}</span>
        </div>`;
    const lineCell = (style, label) =>
        `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#e0e6f0">
            <span style="display:inline-block;width:22px;${style}"></span>
            <span>${label}</span>
        </div>`;
    return `
    <div style="display:flex;flex-wrap:wrap;gap:10px 16px;background:#1a2236;border:1px solid #2a3450;border-radius:8px;padding:8px 12px;margin-bottom:12px">
        ${cell(launchIconSvg(LAUNCH_COLOR, 14), 'Launch')}
        ${cell(apogeeIconSvg(sample, 14), 'Apogee')}
        ${cell(landingIconSvg(sample, 16), 'Landing')}
        ${lineCell('background:repeating-linear-gradient(to right,' + sample + ' 0 6px,transparent 6px 10px);height:2px;', 'Drift / Descent')}
        ${lineCell('background:repeating-linear-gradient(to right,' + sample + ' 0 2px,transparent 2px 10px);height:3px;', 'Ascent')}
        ${lineCell('border:1px dashed ' + sample + ';height:0;', 'Dispersion zone')}
    </div>`;
}

// Builds the "Calculation Details" section for the export report.
// Renders five subsections: Inputs, ORK Source Data (if loaded), Ascent
// Phase breakdown (rod tilt vs weather cocking), Descent Phase breakdown,
// and Dispersion Methodology. Reuses the existing .data-grid/.data-item
// styles so the print stylesheet at app.js:2630 converts it automatically.
function buildCalculationDetailsHtml() {
    if (!lastDispersion || !lastDispersion.primaryResult) return '';

    const {
        primaryResult: pr,
        ellipse,
        apogee: apogeeM,                   // metric, internal
        primaryProfile: profile,           // unperturbed primary wind profile
        forecastTime,
    } = lastDispersion;

    // Display helpers respect the current useImperial setting.
    const altUnit = useImperial ? 'ft' : 'm';
    const speedUnit = useImperial ? 'fps' : 'm/s';
    const fmtAlt = (m) => `${(useImperial ? m * FT_PER_M : m).toFixed(0)} ${altUnit}`;
    const fmtDist = (m) => useImperial
        ? (m * FT_PER_M < 5280 ? `${(m * FT_PER_M).toFixed(0)} ft` : `${(m * FT_PER_M / 5280).toFixed(2)} mi`)
        : (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`);
    const fmtSpeed = (ms) => useImperial ? `${(ms * FPS_PER_MS).toFixed(1)} fps` : `${ms.toFixed(1)} m/s`;
    const fmtBearing = (deg) => `${Math.round(((deg % 360) + 360) % 360)}° (${bearingToCompass(deg)})`;
    const fmtTime = (s) => s < 60 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    const fmtMeters = (m) => `${m.toFixed(1)} m`;

    const sectionTitle = (txt) =>
        `<h3 style="margin:16px 0 6px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.5px">${txt}</h3>`;
    const item = (label, value) =>
        `<div class="data-item"><div class="data-label">${label}</div><div class="data-value">${value}</div></div>`;
    const grid = (rows) => `<div class="data-grid">${rows.join('')}</div>`;

    // Common derived inputs (used by multiple subsections).
    const launchAngleDeg = parseFloat(launchAngleInput.value) || 0;
    const launchAzimuthDeg = parseFloat(launchAzimuthInput.value) || 0;
    const ascentRate_ms = ascentRateInput.value
        ? (useImperial ? parseFloat(ascentRateInput.value) / FPS_PER_MS : parseFloat(ascentRateInput.value))
        : 0;

    let html = '';

    // --- Subsection A: Inputs ---
    const inputRows = [];
    const lat = parseFloat(latInput.value);
    const lon = parseFloat(lonInput.value);
    if (!isNaN(lat) && !isNaN(lon)) {
        inputRows.push(item('Launch Coordinates', `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
    }
    const hh = String(launchHourSelect.value || '').padStart(2, '0');
    const mm = String(launchMinSelect.value || '').padStart(2, '0');
    const ampm = use24h ? '' : ` ${launchAmpmSelect.value}`;
    inputRows.push(item('Launch Time', `${launchDateInput.value} ${hh}:${mm}${ampm}`));
    const apogeeRaw = dualDeploy ? apogeeDualInput.value : apogeeInput.value;
    if (apogeeRaw) inputRows.push(item('Apogee Deployment', `${apogeeRaw} ${altUnit}`));
    if (dualDeploy) {
        if (transitionInput.value) inputRows.push(item('Transition Altitude', `${transitionInput.value} ${altUnit}`));
        if (dr1DualInput.value) inputRows.push(item('Drogue Descent Rate', `${dr1DualInput.value} ${speedUnit}`));
        if (dr2Input.value) inputRows.push(item('Main Descent Rate', `${dr2Input.value} ${speedUnit}`));
    } else if (dr1Input.value) {
        inputRows.push(item('Descent Rate', `${dr1Input.value} ${speedUnit}`));
    }
    if (launchAngleDeg > 0) {
        inputRows.push(item('Launch Rod Tilt', `${launchAngleDeg.toFixed(1)}° from vertical`));
        inputRows.push(item('Launch Rod Azimuth', fmtBearing(launchAzimuthDeg)));
    } else {
        inputRows.push(item('Launch Rod', 'Vertical (no tilt)'));
    }
    if (ascentRateInput.value) {
        const note = orkFlightData ? ' (ORK profile in use)' : '';
        inputRows.push(item('Ascent Rate', `${ascentRateInput.value} ${speedUnit}${note}`));
    } else if (orkFlightData) {
        inputRows.push(item('Ascent Rate', 'Per-step from ORK profile'));
    }
    inputRows.push(item('Wind Data Source', isHistoricalData
        ? 'Open-Meteo historical archive (surface winds extrapolated)'
        : 'Open-Meteo forecast (16 pressure levels, 0–16,200 m)'));
    if (forecastTime) {
        inputRows.push(item('Forecast Hour Used', forecastTime.toLocaleString([], {
            weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        })));
    }
    html += sectionTitle('Calculation Details — Inputs') + grid(inputRows);

    // --- Subsection B: Source data (only when ORK is loaded) ---
    if (orkParsedDoc) {
        const orkRows = [];
        const rocketName = ($('ork-rocket-name')?.textContent || '').trim();
        const motor = ($('ork-motor')?.textContent || '').trim();
        const mass = ($('ork-mass')?.textContent || '').trim();
        if (rocketName) orkRows.push(item('Rocket', rocketName));
        if (motor && motor !== '—') orkRows.push(item('Motor', motor));
        if (mass && mass !== '—') orkRows.push(item('Total Mass', mass));

        // Weather-cocking source label — same selection as calc.js:499-500.
        let cockingSrc;
        if (orkWeathercockB) cockingSrc = 'ORK back-fit (B) — derived from recorded apogee';
        else if (orkWeathercockA && orkWeathercockA.profile) cockingSrc = 'NASA formula (A) via ORK velocity profile';
        else if (ascentRate_ms > 0) cockingSrc = 'NASA formula via constant ascent rate';
        else cockingSrc = 'None (legacy gravity-turn path)';
        orkRows.push(item('Weather-Cocking Source', cockingSrc));

        if (orkWeathercockB) {
            const wb = orkWeathercockB;
            if (typeof wb.coeffAlong === 'number' && typeof wb.coeffCross === 'number') {
                orkRows.push(item('Cocking Coefficients', `along: ${wb.coeffAlong.toFixed(3)}, cross: ${wb.coeffCross.toFixed(3)}`));
            }
            if (typeof wb.apogeePosEast === 'number' && typeof wb.apogeePosNorth === 'number') {
                orkRows.push(item('ORK Apogee Offset', `${wb.apogeePosEast.toFixed(1)} m E, ${wb.apogeePosNorth.toFixed(1)} m N`));
            }
            if (typeof wb.orkWindSpeed === 'number') {
                orkRows.push(item('ORK Sim Wind Speed', fmtSpeed(wb.orkWindSpeed)));
            }
        }
        html += sectionTitle('Calculation Details — Source Data (ORK)') + grid(orkRows);
    }

    // --- Subsection C: Ascent breakdown (only when ascent simulation ran) ---
    const hasCocking = !!orkWeathercockB || (orkWeathercockA && orkWeathercockA.profile) || ascentRate_ms > 0;
    const ranAscentSim = hasCocking || (launchAngleDeg > 0 && (orkFlightData || ascentRate_ms > 0));

    if (ranAscentSim) {
        const ascentRows = [];
        let totalDx = 0, totalDy = 0;

        if (launchAngleDeg > 0) {
            try {
                const rt = computeRodTiltOffset(launchAngleDeg, launchAzimuthDeg, apogeeM, orkFlightData, ascentRate_ms);
                const mag = Math.sqrt(rt.dx * rt.dx + rt.dy * rt.dy);
                const brg = (Math.atan2(rt.dx, rt.dy) * 180 / Math.PI + 360) % 360;
                ascentRows.push(item('Rod Tilt Offset', `${fmtDist(mag)} @ ${fmtBearing(brg)}`));
                ascentRows.push(item('Rod Tilt (E / N)', `${fmtMeters(rt.dx)} E, ${fmtMeters(rt.dy)} N`));
                totalDx += rt.dx; totalDy += rt.dy;
            } catch (e) { console.warn('Rod tilt recompute failed:', e); }
        }

        if (hasCocking && profile) {
            try {
                let cocking, label;
                if (orkWeathercockB) {
                    cocking = computeWeathercockOrkBackfit(profile, orkWeathercockB);
                    label = 'Weather-Cocking (ORK back-fit)';
                } else if (orkWeathercockA && orkWeathercockA.profile) {
                    cocking = computeWeathercockFormula(profile, orkWeathercockA.profile, apogeeM, ascentRate_ms);
                    label = 'Weather-Cocking (NASA formula, ORK V)';
                } else {
                    cocking = computeWeathercockFormula(profile, null, apogeeM, ascentRate_ms);
                    label = 'Weather-Cocking (NASA formula)';
                }
                const mag = Math.sqrt(cocking.dx * cocking.dx + cocking.dy * cocking.dy);
                const brg = (Math.atan2(cocking.dx, cocking.dy) * 180 / Math.PI + 360) % 360;
                ascentRows.push(item(label, `${fmtDist(mag)} @ ${fmtBearing(brg)}`));
                ascentRows.push(item('Cocking (E / N)', `${fmtMeters(cocking.dx)} E, ${fmtMeters(cocking.dy)} N`));
                totalDx += cocking.dx; totalDy += cocking.dy;
            } catch (e) { console.warn('Weather-cocking recompute failed:', e); }
        }

        const totalMag = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
        const totalBrg = (Math.atan2(totalDx, totalDy) * 180 / Math.PI + 360) % 360;
        ascentRows.push(item('Apogee vs. Pad', totalMag > 0.5 ? `${fmtDist(totalMag)} @ ${fmtBearing(totalBrg)}` : 'Directly above pad'));

        if (typeof pr.ascentTime === 'number' && pr.ascentTime > 0) {
            ascentRows.push(item('Ascent Time', fmtTime(pr.ascentTime)));
        } else if (ascentRate_ms > 0) {
            ascentRows.push(item('Ascent Time (est.)', fmtTime(apogeeM / ascentRate_ms)));
        }

        html += sectionTitle('Calculation Details — Ascent Phase') + grid(ascentRows);
    }

    // --- Subsection D: Descent breakdown ---
    const descentRows = [];
    descentRows.push(item('Apogee Altitude', fmtAlt(apogeeM)));
    if (dualDeploy) {
        const transM = useImperial
            ? (parseFloat(transitionInput.value) || 0) / FT_PER_M
            : (parseFloat(transitionInput.value) || 0);
        const dr1_ms = useImperial
            ? (parseFloat(dr1DualInput.value) || 0) / FPS_PER_MS
            : (parseFloat(dr1DualInput.value) || 0);
        const dr2_ms = useImperial
            ? (parseFloat(dr2Input.value) || 0) / FPS_PER_MS
            : (parseFloat(dr2Input.value) || 0);
        const drogueTime = dr1_ms > 0 ? (apogeeM - transM) / dr1_ms : 0;
        const mainTime = dr2_ms > 0 ? transM / dr2_ms : 0;
        descentRows.push(item('Drogue Stage', `${fmtAlt(apogeeM)} → ${fmtAlt(transM)}`));
        descentRows.push(item('Drogue Time (est.)', `${fmtTime(drogueTime)} @ ${fmtSpeed(dr1_ms)}`));
        descentRows.push(item('Main Stage', `${fmtAlt(transM)} → ground`));
        descentRows.push(item('Main Time (est.)', `${fmtTime(mainTime)} @ ${fmtSpeed(dr2_ms)}`));
    } else {
        const dr_ms = useImperial
            ? (parseFloat(dr1Input.value) || 0) / FPS_PER_MS
            : (parseFloat(dr1Input.value) || 0);
        descentRows.push(item('Single Stage', `${fmtAlt(apogeeM)} → ground @ ${fmtSpeed(dr_ms)}`));
    }
    descentRows.push(item('Total Descent Drift', `${fmtDist(pr.driftDistance)} @ ${fmtBearing(pr.driftBearing)}`));
    descentRows.push(item('Total Descent Time', fmtTime(pr.totalTime)));
    descentRows.push(item('Final Landing', `${pr.landingLat.toFixed(5)}, ${pr.landingLon.toFixed(5)}`));
    html += sectionTitle('Calculation Details — Descent Phase') + grid(descentRows);

    // --- Subsection E: Dispersion methodology ---
    const dispRows = [];
    dispRows.push(item('Total Scenarios', '162 (6 hours × 3 wind speeds × 3 directions × 3 descent rates)'));
    dispRows.push(item('Wind Speed Perturbations', '×0.8, ×1.0, ×1.2'));
    dispRows.push(item('Wind Direction Perturbations', '−15°, 0°, +15°'));
    dispRows.push(item('Descent Rate Perturbations', '×0.9, ×1.0, ×1.1'));
    dispRows.push(item('Forecast Hour Window', '+0 h to +5 h from launch time'));
    dispRows.push(item('Confidence Level', '2-σ (95%) via PCA on landing covariance'));
    if (ellipse) {
        dispRows.push(item('Ellipse Major Axis', fmtDist(ellipse.semiMajor * 2)));
        dispRows.push(item('Ellipse Minor Axis', fmtDist(ellipse.semiMinor * 2)));
        dispRows.push(item('Ellipse Rotation', `${ellipse.rotation.toFixed(1)}° from north`));
    }
    html += sectionTitle('Calculation Details — Dispersion Methodology') + grid(dispRows);

    return html;
}

// ============================================================
// SESSION SAVE / LOAD (.fmr files)
// ============================================================

const SESSION_VERSION = 1;
const saveSessionModal = $('save-session-modal');
const saveSessionBtn = $('save-session-btn');
const loadSessionBtn = $('load-session-btn');
const sessionFileInput = $('session-file-input');
const sessionNameInput = $('session-name-input');

// --- Serialization helpers ---

// Snapshot of all form inputs + ancillary UI state. Used both by session
// save/load and by the per-scenario "edit inputs" feature.
function getCurrentFormInputs() {
    return {
        latitude: latInput.value,
        longitude: lonInput.value,
        locationSearch: $('location-search').value,
        launchDate: launchDateInput.value,
        launchHour: launchHourSelect.value,
        launchMin: launchMinSelect.value,
        launchAmpm: launchAmpmSelect.value,
        apogee: apogeeInput.value,
        dr1: dr1Input.value,
        apogeeDual: $('apogee-dual').value,
        dr1Dual: $('dr1-dual').value,
        transition: transitionInput.value,
        dr2: dr2Input.value,
        launchAngle: launchAngleInput.value,
        launchAzimuth: launchAzimuthInput.value,
        ascentRate: ascentRateInput.value,
        calcMass: $('calc-mass').value,
        calcDiameter: $('calc-diameter').value,
        calcCd: $('calc-cd').value,
    };
}

// Restores form input values from a snapshot. Honors hard limits via
// clampInput. Caller is responsible for restoring unit/dualDeploy state
// before invoking this — values are stored in whatever unit was active.
function applyFormInputs(fi) {
    fi = fi || {};
    latInput.value = clampInput('latitude', fi.latitude);
    lonInput.value = clampInput('longitude', fi.longitude);
    $('location-search').value = fi.locationSearch ?? '';
    launchDateInput.value = fi.launchDate ?? '';
    launchHourSelect.value = fi.launchHour ?? '';
    launchMinSelect.value = fi.launchMin ?? '';
    launchAmpmSelect.value = fi.launchAmpm ?? 'AM';
    apogeeInput.value = clampInput('apogee', fi.apogee);
    dr1Input.value = clampInput('dr1', fi.dr1);
    $('apogee-dual').value = clampInput('apogeeDual', fi.apogeeDual);
    $('dr1-dual').value = clampInput('dr1Dual', fi.dr1Dual);
    transitionInput.value = clampInput('transition', fi.transition);
    dr2Input.value = clampInput('dr2', fi.dr2);
    launchAngleInput.value = clampInput('launchAngle', fi.launchAngle);
    launchAzimuthInput.value = clampInput('launchAzimuth', fi.launchAzimuth);
    ascentRateInput.value = clampInput('ascentRate', fi.ascentRate);
    $('calc-mass').value = clampInput('calcMass', fi.calcMass);
    $('calc-diameter').value = clampInput('calcDiameter', fi.calcDiameter);
    $('calc-cd').value = clampInput('calcCd', fi.calcCd);
}

function serializeDispersion(disp) {
    if (!disp) return null;
    const clone = JSON.parse(JSON.stringify(disp));
    // forecastTime is a Date — already stringified by JSON.stringify
    return clone;
}

function deserializeDispersion(obj) {
    if (!obj) return null;
    if (obj.forecastTime && typeof obj.forecastTime === 'string') {
        obj.forecastTime = new Date(obj.forecastTime);
    }
    return obj;
}

// Collects all saveable application state.
function collectSessionState(sessionName) {
    return {
        version: SESSION_VERSION,
        appName: 'FindMyRocket',
        savedAt: new Date().toISOString(),
        sessionName,

        formInputs: getCurrentFormInputs(),

        unitState: {
            useImperial,
            massSmallUnit,
            diaSmallUnit,
            use24h,
        },

        dualDeploy,

        orkExtracted: orkFlightData || orkMotorConfigs.length > 0 ? {
            flightData: orkFlightData,
            motorConfigs: orkMotorConfigs,
            rocketName: $('ork-rocket-name')?.textContent || '',
            motorDesignation: $('ork-motor')?.textContent || '',
            massDisplay: $('ork-mass')?.textContent || '',
            recoveryDisplay: $('ork-recovery')?.textContent || '',
            summaryVisible: !orkSummary.hidden,
            selectedConfigId: $('ork-motor-select')?.value || null,
            weathercockA: orkWeathercockA,
            weathercockB: orkWeathercockB,
            weathercockInfoText: $('weathercock-info')?.textContent || '',
        } : null,

        lastDispersion: serializeDispersion(lastDispersion),
        lastLaunchLat,
        lastLaunchLon,

        scenarios: scenarios.map(s => ({
            id: s.id,
            name: s.name,
            color: s.color,
            visible: s.visible,
            dispersion: serializeDispersion(s.dispersion),
            launchLat: s.launchLat,
            launchLon: s.launchLon,
            formInputs: s.formInputs || null,
            uiState: s.uiState || null,
        })),
        activeScenarioIndex,
        currentVisible,
        scenarioCounter,

        mapState: {
            center: [map.getCenter().lat, map.getCenter().lng],
            zoom: map.getZoom(),
        },
    };
}

// Triggers browser download of the session file.
function downloadSession(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Clears all current state before loading a session.
function clearAllState() {
    // Remove scenario map layers.
    for (const s of scenarios) {
        s.mapLayerGroup.clearLayers();
        s.mapLayerGroup.remove();
    }
    scenarios.length = 0;
    activeScenarioIndex = -1;
    currentVisible = true;
    scenarioCounter = 0;

    // Clear current result.
    lastDispersion = null;
    lastLaunchLat = null;
    lastLaunchLon = null;
    mapLayers.clearLayers();
    resultsPanel.hidden = true;

    // Clear ork state.
    orkFlightData = null;
    orkParsedDoc = null;
    orkMotorConfigs = [];
    orkWeathercockA = null;
    orkWeathercockB = null;
    orkSummary.hidden = true;
    const wcInfoEl = $('weathercock-info');
    if (wcInfoEl) { wcInfoEl.hidden = true; wcInfoEl.textContent = ''; }
    clearAutoFilled();

    // Clear scenario bar and comparison table.
    renderScenarioBar();
    renderComparisonTable();
}

// Restores all application state from a loaded session.
function restoreSessionState(data) {
    clearAllState();

    // 1. Unit system (before form values — values are stored in the saved unit system).
    const savedImperial = data.unitState?.useImperial ?? true;
    const savedMassSmall = data.unitState?.massSmallUnit ?? false;
    const savedDiaSmall = data.unitState?.diaSmallUnit ?? false;
    const saved24h = data.unitState?.use24h ?? true;

    // Set unit system without converting values (we'll set raw values from save).
    useImperial = savedImperial;
    massSmallUnit = savedMassSmall;
    diaSmallUnit = savedDiaSmall;
    if (savedImperial) {
        imperialBtn.classList.add('active');
        metricBtn.classList.remove('active');
    } else {
        metricBtn.classList.add('active');
        imperialBtn.classList.remove('active');
    }
    updateUnitLabels();

    // 2. Time format.
    use24h = saved24h;
    timeFormatLabel.textContent = use24h ? '24h' : '12h';
    populateHourSelect();

    // 3. Deploy mode.
    const savedDual = data.dualDeploy ?? false;
    if (savedDual && !dualDeploy) modeDualBtn.click();
    else if (!savedDual && dualDeploy) modeSingleBtn.click();

    // 4. Form input values (clamped to hard limits to guard against hand-edited .fmr files).
    const fi = data.formInputs || {};
    applyFormInputs(fi);

    // 5. ORK extracted data (restore display without raw XML).
    if (data.orkExtracted && data.orkExtracted.summaryVisible) {
        const ork = data.orkExtracted;
        orkFlightData = ork.flightData || null;
        orkMotorConfigs = ork.motorConfigs || [];
        orkWeathercockA = ork.weathercockA || null;
        orkWeathercockB = ork.weathercockB || null;

        $('ork-rocket-name').textContent = ork.rocketName || 'Unknown Rocket';
        $('ork-motor').textContent = ork.motorDesignation || '—';
        $('ork-mass').textContent = ork.massDisplay || '—';
        $('ork-recovery').textContent = ork.recoveryDisplay || '—';
        orkSummary.hidden = false;

        const wcInfo = $('weathercock-info');
        if (wcInfo && ork.weathercockInfoText) {
            wcInfo.textContent = ork.weathercockInfoText;
            wcInfo.hidden = false;
        }

        // Render motor config selector but disable switching (no raw XML).
        if (orkMotorConfigs.length > 1) {
            renderMotorConfigSelector();
            const select = $('ork-motor-select');
            if (ork.selectedConfigId) select.value = ork.selectedConfigId;
            select.disabled = true;
            select.title = 'Re-import the .ork file to switch motor configurations';
        }
    }

    // 6. Map state and launch pin.
    if (data.mapState) {
        map.setView(data.mapState.center, data.mapState.zoom);
    }
    const lat = parseFloat(fi.latitude);
    const lon = parseFloat(fi.longitude);
    if (!isNaN(lat) && !isNaN(lon)) {
        updatePinPosition(lat, lon);
    }

    // Update azimuth compass if value exists.
    const azVal = parseFloat(fi.launchAzimuth);
    if (!isNaN(azVal)) {
        const compass = $('azimuth-compass');
        if (compass) compass.style.transform = `rotate(${azVal}deg)`;
    }

    // 7. Dispersion results.
    lastDispersion = deserializeDispersion(data.lastDispersion);
    lastLaunchLat = data.lastLaunchLat ?? null;
    lastLaunchLon = data.lastLaunchLon ?? null;

    // 8. Scenarios.
    if (data.scenarios && data.scenarios.length > 0) {
        for (const sd of data.scenarios) {
            scenarios.push({
                id: sd.id,
                name: sd.name,
                color: sd.color,
                visible: sd.visible,
                dispersion: deserializeDispersion(sd.dispersion),
                launchLat: sd.launchLat,
                launchLon: sd.launchLon,
                mapLayerGroup: L.layerGroup(),
                formInputs: sd.formInputs || null,
                uiState: sd.uiState || null,
            });
        }
    }
    activeScenarioIndex = data.activeScenarioIndex ?? -1;
    currentVisible = data.currentVisible ?? true;
    scenarioCounter = data.scenarioCounter ?? 0;

    // 9. Render everything.
    if (lastDispersion && lastLaunchLat != null) {
        renderResultCards(lastDispersion);
        renderWindTable(lastDispersion);
        renderAllScenarios();
        resultsPanel.hidden = false;
    }

    // Show the correct scenario's results if one was selected.
    if (activeScenarioIndex >= 0 && activeScenarioIndex < scenarios.length) {
        renderResultCards(scenarios[activeScenarioIndex].dispersion);
        renderWindTable(scenarios[activeScenarioIndex].dispersion);
    }

    renderScenarioBar();
    renderComparisonTable();
}

// --- Save button handler ---
saveSessionBtn.addEventListener('click', () => {
    // Pre-fill session name with rocket name if available.
    const rocketName = $('ork-rocket-name')?.textContent;
    const defaultName = rocketName && rocketName !== 'Unknown Rocket' && !orkSummary.hidden
        ? rocketName
        : 'FindMyRocket Session';
    sessionNameInput.value = defaultName;
    saveSessionModal.hidden = false;
    sessionNameInput.focus();
    sessionNameInput.select();
});

$('save-session-close').addEventListener('click', () => {
    saveSessionModal.hidden = true;
});

saveSessionModal.addEventListener('click', (e) => {
    if (e.target === saveSessionModal) saveSessionModal.hidden = true;
});

sessionNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save-session-go').click();
});

$('save-session-go').addEventListener('click', () => {
    const name = sessionNameInput.value.trim() || 'FindMyRocket Session';
    const data = collectSessionState(name);
    const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
    downloadSession(data, `${safeName}.fmr`);
    saveSessionModal.hidden = true;
    showToast('Session saved');
});

// --- Load button handler ---
loadSessionBtn.addEventListener('click', () => {
    sessionFileInput.click();
});

sessionFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    sessionFileInput.value = '';

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Validate.
        if (data.appName !== 'FindMyRocket') {
            throw new Error('Not a valid FindMyRocket session file');
        }
        if (typeof data.version !== 'number') {
            throw new Error('Missing version in session file');
        }
        if (data.version > SESSION_VERSION) {
            showToast('This file was created with a newer version — some data may not load correctly', 'warning');
        }

        // Confirm if there's existing state.
        const hasState = lastDispersion || scenarios.length > 0;
        if (hasState) {
            if (!confirm('Loading a session will replace all current data. Continue?')) return;
        }

        restoreSessionState(data);
        showToast(`Session loaded: ${data.sessionName || file.name}`);
    } catch (err) {
        console.error('Session load error:', err);
        showToast(err.message || 'Failed to load session file', 'error');
    }
});

// ============================================================
// EASTER EGG — click header 5× to launch the rocket icon
// ============================================================
(() => {
    const headerContent = document.querySelector('.header-content');
    const rocketIcon = document.querySelector('.rocket-icon');
    if (!headerContent || !rocketIcon) return;

    let clickCount = 0;
    let resetTimer = null;
    let animating = false;

    headerContent.addEventListener('click', (e) => {
        // Ignore clicks on the unit toggle buttons
        if (e.target.closest('.unit-toggle')) return;
        if (animating) return;

        clickCount++;
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { clickCount = 0; }, 2000);

        if (clickCount >= 5) {
            clickCount = 0;
            animating = true;

            headerContent.classList.add('easter-active');

            const rect = rocketIcon.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    const el = document.createElement('div');
                    el.className = 'smoke-ring';
                    el.style.left = (cx - 5) + 'px';
                    el.style.top = (cy - 5) + 'px';
                    el.style.animation = 'smokeExpand 0.8s ease-out forwards';
                    document.body.appendChild(el);
                    setTimeout(() => el.remove(), 800);
                }, i * 200);
            }

            const flameInterval = setInterval(() => {
                const r = rocketIcon.getBoundingClientRect();
                const el = document.createElement('div');
                el.className = 'flame-particle';
                const colors = ['#ff4c29', '#ff8c42', '#fbbf24', '#ef4444', '#ff6b35'];
                el.style.background = colors[Math.floor(Math.random() * colors.length)];
                el.style.left = (r.left + r.width / 2 + (Math.random() - 0.5) * 10) + 'px';
                el.style.top = (r.top + r.height) + 'px';
                el.style.animation = `flameFade ${0.4 + Math.random() * 0.4}s ease-out forwards`;
                document.body.appendChild(el);
                setTimeout(() => el.remove(), 800);
            }, 50);

            setTimeout(() => {
                for (let i = 0; i < 12; i++) {
                    const el = document.createElement('div');
                    el.className = 'star-burst';
                    el.textContent = ['\u2726', '\u2727', '\u26A1', '\uD83D\uDCA5', '\uD83D\uDD25'][Math.floor(Math.random() * 5)];
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 80 + Math.random() * 120;
                    el.style.left = cx + 'px';
                    el.style.top = (cy - 200) + 'px';
                    el.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
                    el.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
                    el.style.animation = `starFly ${0.6 + Math.random() * 0.6}s ease-out forwards`;
                    document.body.appendChild(el);
                    setTimeout(() => el.remove(), 1200);
                }
            }, 1200);

            setTimeout(() => clearInterval(flameInterval), 2000);

            setTimeout(() => {
                headerContent.classList.remove('easter-active');
                animating = false;
            }, 2600);
        }
    });
})();
