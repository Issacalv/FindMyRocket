// ============================================================
// FindMyRocket -- Pure Calculation Functions
//
// Extracted from app.js for testability. Contains all constants
// and pure functions with no DOM dependencies.
// ============================================================

// --- Constants ---

// Standard atmospheric pressure levels (in hPa) used by the Open-Meteo
// forecast API. These correspond to altitudes from near sea level (~110m
// at 1000 hPa) up to ~16,180m at 100 hPa.
export const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100];

// Approximate altitudes (meters) for each pressure level, used as a
// fallback when the API doesn't return geopotential height data.
// Values are from the International Standard Atmosphere (ISA).
export const FALLBACK_ALTITUDES = {
    1000: 110, 975: 320, 950: 540, 925: 760, 900: 990,
    850: 1460, 800: 1950, 700: 3010, 600: 4210, 500: 5570,
    400: 7190, 300: 9160, 250: 10360, 200: 11780, 150: 13600, 100: 16180
};

// Altitude step size (meters) for the numerical integration during
// drift calculation. Smaller steps = more accurate but slower.
export const ALT_STEP = 50;

export const DEG_TO_RAD = Math.PI / 180;

// Approximate meters per degree of latitude (constant everywhere on Earth).
// Longitude conversion requires an additional cos(latitude) factor.
export const METERS_PER_DEG_LAT = 111320;

// --- Unit System ---

export const FT_PER_M = 3.28084;       // feet per meter
export const FPS_PER_MS = 3.28084;     // ft/s per m/s (same numeric value)
export const MPH_PER_MS = 2.23694;     // mph per m/s

// Hard altitude cap based on the highest pressure level (100 hPa).
export const MAX_ALTITUDE_M = 16200;
export const MAX_ALTITUDE_FT = Math.round(MAX_ALTITUDE_M * FT_PER_M);

// Air density at sea level (kg/m³) for descent rate calculation.
export const AIR_DENSITY_SEA_LEVEL = 1.225;

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
export function buildWindProfile(data, hourIndex, isHistoricalData) {
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
        const refSpeed = Math.max(spd100, spd10, 0.5);
        const alpha = spd10 > 0.01 ? Math.log(spd100 / spd10) / Math.log(100 / 10) : 0.14;
        const clampedAlpha = Math.max(0.05, Math.min(alpha, 0.4));

        // Extrapolate at representative altitudes up to 16,000m.
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
        const alt = geoAlt != null ? geoAlt : FALLBACK_ALTITUDES[p];
        profile.push({ altitude: alt, speed, direction: dir });
    }
    profile.sort((a, b) => a.altitude - b.altitude);
    return profile;
}

// ============================================================
// WIND INTERPOLATION
// ============================================================

// Returns interpolated wind speed and direction at an arbitrary altitude
// by linearly interpolating between the two nearest profile layers.
// Below the lowest layer, returns the lowest layer's values.
// Above the highest layer, returns the highest layer's values.
// Direction interpolation handles the 0/360 wrap-around correctly.
export function interpolateWind(profile, alt) {
    if (profile.length === 0) return { speed: 0, direction: 0 };
    if (alt <= profile[0].altitude) return { speed: profile[0].speed, direction: profile[0].direction };
    if (alt >= profile[profile.length - 1].altitude) {
        const top = profile[profile.length - 1];
        return { speed: top.speed, direction: top.direction };
    }
    for (let i = 0; i < profile.length - 1; i++) {
        if (alt >= profile[i].altitude && alt <= profile[i + 1].altitude) {
            const t = (alt - profile[i].altitude) / (profile[i + 1].altitude - profile[i].altitude);
            const speed = profile[i].speed + t * (profile[i + 1].speed - profile[i].speed);
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
// ASCENT SIMULATION
// ============================================================

// Simulates the rocket's ascent from ground to apogee, accounting for
// the launch angle and wind drift at each altitude step. The launch
// angle decays linearly to zero at apogee (gravity turn approximation).
//
// Parameters (all metric):
//   profile        -- wind profile array from buildWindProfile
//   apogeeAlt      -- apogee altitude in meters AGL
//   launchAngleDeg -- launch angle in degrees from vertical (0 = vertical)
//   launchAzimuthDeg -- compass direction the launch rail points (0 = N, 90 = E)
//   ascentRate     -- average vertical ascent rate in m/s
//   launchLat/Lon  -- launch site coordinates in decimal degrees
//
// Returns:
//   dx, dy       -- total east-west and north-south displacement at apogee (m)
//   path         -- array of [lat, lon] points for drawing the ascent path
//   ascentTime   -- total ascent time in seconds
export function simulateAscent(profile, apogeeAlt, launchAngleDeg, launchAzimuthDeg, ascentRate, launchLat, launchLon) {
    if (launchAngleDeg <= 0 || ascentRate <= 0) {
        return { dx: 0, dy: 0, path: [[launchLat, launchLon]], ascentTime: 0 };
    }

    const angleRad = launchAngleDeg * DEG_TO_RAD;
    const azimuthRad = launchAzimuthDeg * DEG_TO_RAD;
    let dx = 0, dy = 0, totalTime = 0;
    let currentAlt = 0;
    const path = [[launchLat, launchLon]];

    while (currentAlt < apogeeAlt) {
        const step = Math.min(ALT_STEP, apogeeAlt - currentAlt);
        const midAlt = currentAlt + step / 2;
        const dt = step / ascentRate;
        totalTime += dt;

        // Launch angle decays linearly from full at ground to zero at apogee.
        const fractionRemaining = 1 - (midAlt / apogeeAlt);
        const effectiveAngle = angleRad * fractionRemaining;
        const horizontalVelocity = ascentRate * Math.tan(effectiveAngle);

        dx += horizontalVelocity * Math.sin(azimuthRad) * dt;
        dy += horizontalVelocity * Math.cos(azimuthRad) * dt;

        // Wind drift during ascent.
        const wind = interpolateWind(profile, midAlt);
        const windDirRad = (wind.direction + 180) * DEG_TO_RAD;
        dx += wind.speed * Math.sin(windDirRad) * dt;
        dy += wind.speed * Math.cos(windDirRad) * dt;

        currentAlt += step;

        const dlat = dy / METERS_PER_DEG_LAT;
        const dlon = dx / (METERS_PER_DEG_LAT * Math.cos(launchLat * DEG_TO_RAD));
        path.push([launchLat + dlat, launchLon + dlon]);
    }

    return { dx, dy, path, ascentTime: totalTime };
}

// Simulates the ascent using an OpenRocket time-vs-altitude profile
// for more accurate timing. Falls back to wind-only drift if no
// launch angle is provided.
//
// Parameters:
//   windProfile     -- wind profile array from buildWindProfile
//   ascentProfile   -- array of { time, altitude } from ORK data
//   launchAngleDeg  -- launch angle in degrees from vertical (0 = vertical)
//   launchAzimuthDeg -- compass direction the launch rail points
//   launchLat/Lon   -- launch site coordinates in decimal degrees
export function simulateAscentFromProfile(windProfile, ascentProfile, launchAngleDeg, launchAzimuthDeg, launchLat, launchLon) {
    if (!ascentProfile || ascentProfile.length < 2) {
        return { dx: 0, dy: 0, path: [[launchLat, launchLon]], ascentTime: 0 };
    }

    const angleRad = launchAngleDeg * DEG_TO_RAD;
    const azimuthRad = launchAzimuthDeg * DEG_TO_RAD;
    const maxAlt = ascentProfile[ascentProfile.length - 1].altitude;

    let dx = 0, dy = 0;
    const path = [[launchLat, launchLon]];

    for (let i = 1; i < ascentProfile.length; i++) {
        const dt = ascentProfile[i].time - ascentProfile[i - 1].time;
        if (dt <= 0) continue;

        const midAlt = (ascentProfile[i].altitude + ascentProfile[i - 1].altitude) / 2;

        // Angular displacement with gravity turn decay.
        if (launchAngleDeg > 0 && maxAlt > 0) {
            const verticalVelocity = (ascentProfile[i].altitude - ascentProfile[i - 1].altitude) / dt;
            const fractionRemaining = Math.max(0, 1 - (midAlt / maxAlt));
            const effectiveAngle = angleRad * fractionRemaining;
            const horizontalVelocity = verticalVelocity * Math.tan(effectiveAngle);

            dx += horizontalVelocity * Math.sin(azimuthRad) * dt;
            dy += horizontalVelocity * Math.cos(azimuthRad) * dt;
        }

        // Wind drift during ascent.
        const wind = interpolateWind(windProfile, midAlt);
        const windDirRad = (wind.direction + 180) * DEG_TO_RAD;
        dx += wind.speed * Math.sin(windDirRad) * dt;
        dy += wind.speed * Math.cos(windDirRad) * dt;

        const dlat = dy / METERS_PER_DEG_LAT;
        const dlon = dx / (METERS_PER_DEG_LAT * Math.cos(launchLat * DEG_TO_RAD));
        path.push([launchLat + dlat, launchLon + dlon]);
    }

    const ascentTime = ascentProfile[ascentProfile.length - 1].time - ascentProfile[0].time;
    return { dx, dy, path, ascentTime };
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
//   initialDx/Dy -- optional horizontal offset at apogee (m), e.g. from
//                    ascent simulation with a launch angle
//
// Returns an object with:
//   landingLat/Lon -- predicted landing coordinates
//   totalTime      -- total descent time in seconds
//   driftDistance   -- straight-line distance from launch to landing (m)
//   driftBearing   -- compass bearing from launch to landing (degrees)
//   path           -- array of [lat, lon] points for drawing the drift path
//   dx, dy         -- total east-west and north-south displacement (m)
export function calculateDrift(profile, apogee, transitionAlt, dr1, dr2, launchLat, launchLon, initialDx = 0, initialDy = 0) {
    let dx = initialDx, dy = initialDy;
    let totalTime = 0;

    // Start the descent path at the apogee position (offset from pad if launched at an angle).
    const startDlat = dy / METERS_PER_DEG_LAT;
    const startDlon = dx / (METERS_PER_DEG_LAT * Math.cos(launchLat * DEG_TO_RAD));
    const path = [[launchLat + startDlat, launchLon + startDlon]];
    let currentAlt = Math.min(apogee, MAX_ALTITUDE_M);

    while (currentAlt > 0) {
        const step = Math.min(ALT_STEP, currentAlt);
        const midAlt = currentAlt - step / 2;
        const descentRate = currentAlt > transitionAlt ? dr1 : dr2;
        const dt = step / descentRate;
        totalTime += dt;

        const wind = interpolateWind(profile, midAlt);
        const dirRad = (wind.direction + 180) * DEG_TO_RAD;

        dx += wind.speed * Math.sin(dirRad) * dt;
        dy += wind.speed * Math.cos(dirRad) * dt;

        currentAlt -= step;

        const dlat = dy / METERS_PER_DEG_LAT;
        const dlon = dx / (METERS_PER_DEG_LAT * Math.cos(launchLat * DEG_TO_RAD));
        path.push([launchLat + dlat, launchLon + dlon]);
    }

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
// When a launch angle is provided, each scenario also simulates the ascent
// phase with the perturbed wind profile, so wind uncertainty during ascent
// naturally widens the dispersion zone.
//
// Total scenarios: 6 hours * 3 speeds * 3 dirs * 3 rates = 162
export function calculateDispersion(apiData, apogee, transitionAlt, dr1, dr2, lat, lon, launchTime, isHistoricalData,
                                     launchAngleDeg = 0, launchAzimuthDeg = 0, ascentRate = 0, orkAscentProfile = null) {
    const landingPoints = [];

    const target = launchTime || new Date();
    const times = apiData.hourly.time.map(t => new Date(t));
    let baseIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
        const diff = Math.abs(times[i] - target);
        if (diff < minDiff) { minDiff = diff; baseIdx = i; }
    }

    const hourIndices = [];
    for (let h = 0; h < 6 && baseIdx + h < times.length; h++) {
        hourIndices.push(baseIdx + h);
    }

    const speedFactors = [0.8, 1.0, 1.2];
    const dirOffsets = [-15, 0, 15];
    const drFactors = [0.9, 1.0, 1.1];

    const hasAscent = (launchAngleDeg > 0 && ascentRate > 0) || orkAscentProfile;

    let primaryResult = null;
    let primaryProfile = null;
    let primaryAscentPath = null;

    for (const hi of hourIndices) {
        const profile = buildWindProfile(apiData, hi, isHistoricalData);
        for (const sf of speedFactors) {
            for (const dOff of dirOffsets) {
                for (const drf of drFactors) {
                    const perturbedProfile = profile.map(p => ({
                        altitude: p.altitude,
                        speed: p.speed * sf,
                        direction: (p.direction + dOff + 360) % 360
                    }));

                    // Simulate ascent with the same perturbed wind profile.
                    let ascentDx = 0, ascentDy = 0;
                    let ascentPath = null;
                    if (hasAscent) {
                        let ascentResult;
                        if (orkAscentProfile) {
                            ascentResult = simulateAscentFromProfile(perturbedProfile, orkAscentProfile, launchAngleDeg, launchAzimuthDeg, lat, lon);
                        } else {
                            ascentResult = simulateAscent(perturbedProfile, apogee, launchAngleDeg, launchAzimuthDeg, ascentRate, lat, lon);
                        }
                        ascentDx = ascentResult.dx;
                        ascentDy = ascentResult.dy;
                        ascentPath = ascentResult.path;
                    }

                    const result = calculateDrift(perturbedProfile, apogee, transitionAlt, dr1 * drf, dr2 * drf, lat, lon, ascentDx, ascentDy);
                    landingPoints.push({ lat: result.landingLat, lon: result.landingLon });

                    if (hi === baseIdx && sf === 1.0 && dOff === 0 && drf === 1.0) {
                        primaryResult = result;
                        primaryProfile = profile;
                        primaryAscentPath = ascentPath;
                    }
                }
            }
        }
    }

    const ellipse = fitEllipse(landingPoints, lat);
    const forecastTime = times[baseIdx];
    return { primaryResult, primaryProfile, primaryAscentPath, ellipse, landingPoints, forecastTime, apogee };
}

// ============================================================
// ELLIPSE FITTING
// ============================================================

// Fits a 2-sigma (95% confidence) ellipse to a set of landing points
// using principal component analysis (eigendecomposition of the 2x2
// covariance matrix).
export function fitEllipse(points, refLat) {
    const n = points.length;
    if (n < 3) return null;

    const meanLat = points.reduce((s, p) => s + p.lat, 0) / n;
    const meanLon = points.reduce((s, p) => s + p.lon, 0) / n;

    const cosLat = Math.cos(meanLat * DEG_TO_RAD);
    const xs = points.map(p => (p.lon - meanLon) * METERS_PER_DEG_LAT * cosLat);
    const ys = points.map(p => (p.lat - meanLat) * METERS_PER_DEG_LAT);

    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < n; i++) {
        cxx += xs[i] * xs[i];
        cyy += ys[i] * ys[i];
        cxy += xs[i] * ys[i];
    }
    cxx /= n; cyy /= n; cxy /= n;

    const trace = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const lambda1 = trace / 2 + disc;
    const lambda2 = trace / 2 - disc;

    const semiMajor = 2 * Math.sqrt(Math.max(0, lambda1));
    const semiMinor = 2 * Math.sqrt(Math.max(0, lambda2));

    const rotation = Math.atan2(cxy, lambda1 - cyy) * 180 / Math.PI;

    return { centerLat: meanLat, centerLon: meanLon, semiMajor, semiMinor, rotation };
}

// Generates an array of [lat, lon] points forming an ellipse on the map.
export function createEllipsePoints(center, semiMajor, semiMinor, rotationDeg, numPoints = 72) {
    const points = [];
    const rot = rotationDeg * DEG_TO_RAD;
    const cosLat = Math.cos(center[0] * DEG_TO_RAD);
    for (let i = 0; i < numPoints; i++) {
        const angle = (2 * Math.PI * i) / numPoints;
        const x = semiMajor * Math.cos(angle);
        const y = semiMinor * Math.sin(angle);
        const xr = x * Math.cos(rot) - y * Math.sin(rot);
        const yr = x * Math.sin(rot) + y * Math.cos(rot);
        const lat = center[0] + yr / METERS_PER_DEG_LAT;
        const lon = center[1] + xr / (METERS_PER_DEG_LAT * cosLat);
        points.push([lat, lon]);
    }
    return points;
}

// ============================================================
// UTILITIES
// ============================================================

// Converts a bearing (0-360 degrees) to an 8-point compass direction.
export function bearingToCompass(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

// Terminal velocity calculation for a rocket under parachute.
export function calcDescentRateFromParams(massKg, diameterM, cd) {
    const area = Math.PI * Math.pow(diameterM / 2, 2);
    return Math.sqrt((2 * massKg * 9.81) / (AIR_DENSITY_SEA_LEVEL * cd * area));
}
