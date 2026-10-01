/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * DarkFleet Camera Controller
 * Smooth flight paths, target tracking focus, spatial presets, and inspection easing.
 */

import { Viewer, Cartesian3, Math as CesiumMath, Rectangle } from 'cesium';
import { BoundingBox, RegionScenario, VesselTarget } from '../types/darkfleet.ts';

export function flyToWorld(viewer: Viewer, duration = 2.5): void {
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(100.0, 15.0, 18000000),
    orientation: {
      heading: CesiumMath.toRadians(0),
      pitch: CesiumMath.toRadians(-90),
      roll: 0,
    },
    duration,
  });
}

export function resetGlobe(viewer: Viewer, duration = 2.5): void {
  flyToWorld(viewer, duration);
}

export function flyToAOI(viewer: Viewer, bbox: BoundingBox, duration = 2.0): void {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const rectangle = Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);
  viewer.camera.flyTo({
    destination: rectangle,
    orientation: {
      heading: 0,
      pitch: CesiumMath.toRadians(-70),
      roll: 0,
    },
    duration,
  });
}

export function flyToScenario(viewer: Viewer, scenario: RegionScenario, duration = 2.2): void {
  const [lat, lon] = scenario.center;
  const altitude = Math.max(120000, 2400000 / Math.pow(2, scenario.zoom - 9));

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat, altitude),
    orientation: {
      heading: CesiumMath.toRadians(0),
      pitch: CesiumMath.toRadians(-68),
      roll: 0,
    },
    duration,
  });
}

export function flyToTarget(viewer: Viewer, target: VesselTarget, duration = 1.5): void {
  const headingRad = CesiumMath.toRadians(target.estimatedHeadingDeg);

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(
      target.position.lon,
      target.position.lat - 0.04,
      8500
    ),
    orientation: {
      heading: headingRad,
      pitch: CesiumMath.toRadians(-55),
      roll: 0,
    },
    duration,
  });
}

export function focusTarget(viewer: Viewer, target: VesselTarget, duration = 1.5): void {
  flyToTarget(viewer, target, duration);
}

export function inspectTarget(viewer: Viewer, target: VesselTarget, duration = 1.2): void {
  // Close-in inspection angle with heading alignment
  const headingRad = CesiumMath.toRadians(target.estimatedHeadingDeg);
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(
      target.position.lon,
      target.position.lat - 0.015,
      2800
    ),
    orientation: {
      heading: headingRad,
      pitch: CesiumMath.toRadians(-45),
      roll: 0,
    },
    duration,
  });
}

export function releaseTarget(viewer: Viewer, scenario?: RegionScenario): void {
  if (scenario) {
    flyToScenario(viewer, scenario, 1.8);
  } else {
    topDown(viewer);
  }
}

export function northUp(viewer: Viewer, duration = 1.0): void {
  const currentPos = viewer.camera.positionCartographic;
  const lon = CesiumMath.toDegrees(currentPos.longitude);
  const lat = CesiumMath.toDegrees(currentPos.latitude);

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat, currentPos.height),
    orientation: {
      heading: 0,
      pitch: viewer.camera.pitch,
      roll: 0,
    },
    duration,
  });
}

export function topDown(viewer: Viewer, duration = 1.0): void {
  const currentPos = viewer.camera.positionCartographic;
  const lon = CesiumMath.toDegrees(currentPos.longitude);
  const lat = CesiumMath.toDegrees(currentPos.latitude);

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat, currentPos.height),
    orientation: {
      heading: viewer.camera.heading,
      pitch: CesiumMath.toRadians(-90),
      roll: 0,
    },
    duration,
  });
}

export function setTopDown(viewer: Viewer): void {
  topDown(viewer);
}

export function oblique(viewer: Viewer, duration = 1.2): void {
  const currentPos = viewer.camera.positionCartographic;
  const lon = CesiumMath.toDegrees(currentPos.longitude);
  const lat = CesiumMath.toDegrees(currentPos.latitude);
  const height = Math.min(currentPos.height, 45000);

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lon, lat - 0.15, height),
    orientation: {
      heading: viewer.camera.heading,
      pitch: CesiumMath.toRadians(-35),
      roll: 0,
    },
    duration,
  });
}

export function setOrbit(viewer: Viewer): void {
  oblique(viewer);
}
