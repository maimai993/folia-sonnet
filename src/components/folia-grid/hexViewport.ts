export interface CubeCoord {
    x: number;
    y: number;
    z: number;
}

export interface HexGridCoord {
    index: number;
    cube: CubeCoord;
    baseX: number;
    baseY: number;
}

export const toCubeKey = (cube: CubeCoord): string => `${cube.x}:${cube.y}:${cube.z}`;

const normalizeZero = (value: number): number => (Object.is(value, -0) ? 0 : value);

// Rounds fractional cube coordinates back onto the x + y + z = 0 hex grid.
export const roundCube = (cube: CubeCoord): CubeCoord => {
    let rx = Math.round(cube.x);
    let ry = Math.round(cube.y);
    let rz = Math.round(cube.z);

    const xDiff = Math.abs(rx - cube.x);
    const yDiff = Math.abs(ry - cube.y);
    const zDiff = Math.abs(rz - cube.z);

    if (xDiff > yDiff && xDiff > zDiff) {
        rx = -ry - rz;
    } else if (yDiff > zDiff) {
        ry = -rx - rz;
    } else {
        rz = -rx - ry;
    }

    return { x: normalizeZero(rx), y: normalizeZero(ry), z: normalizeZero(rz) };
};

export const pixelToCubeCenter = (
    worldX: number,
    worldY: number,
    spacingX: number,
    spacingY: number
): CubeCoord => {
    const z = worldY / spacingY;
    const x = (worldX - (z * spacingX) / 2) / spacingX;
    const y = -x - z;
    return roundCube({ x, y, z });
};

// Enumerates all cube cells within a hex-distance radius around the center.
export const forEachCubeInRadius = (
    center: CubeCoord,
    radius: number,
    callback: (cube: CubeCoord) => void
): void => {
    const safeRadius = Math.max(0, Math.floor(radius));
    for (let dx = -safeRadius; dx <= safeRadius; dx++) {
        const minDy = Math.max(-safeRadius, -dx - safeRadius);
        const maxDy = Math.min(safeRadius, -dx + safeRadius);
        for (let dy = minDy; dy <= maxDy; dy++) {
            const dz = -dx - dy;
            callback({
                x: center.x + dx,
                y: center.y + dy,
                z: center.z + dz,
            });
        }
    }
};

export const getHexCubicSpiral = (count: number): CubeCoord[] => {
    const results: CubeCoord[] = [{ x: 0, y: 0, z: 0 }];
    if (count <= 1) return results.slice(0, count);

    const dirs = [
        { x: 0, y: 1, z: -1 },
        { x: -1, y: 1, z: 0 },
        { x: -1, y: 0, z: 1 },
        { x: 0, y: -1, z: 1 },
        { x: 1, y: -1, z: 0 },
        { x: 1, y: 0, z: -1 },
    ];

    let radius = 1;
    while (results.length < count) {
        let currX = radius;
        let currY = -radius;
        let currZ = 0;

        for (let side = 0; side < 6; side++) {
            for (let step = 0; step < radius; step++) {
                if (results.length >= count) break;
                currX += dirs[side].x;
                currY += dirs[side].y;
                currZ += dirs[side].z;
                results.push({ x: currX, y: currY, z: currZ });
            }
        }
        radius++;
    }

    return results;
};

export const buildHexGridCoords = (
    count: number,
    spacingX: number,
    spacingY: number
): HexGridCoord[] => {
    const cubics = getHexCubicSpiral(count);
    return cubics.map((cubic, index) => ({
        index,
        cube: cubic,
        baseX: cubic.x * spacingX + (cubic.z * spacingX) / 2,
        baseY: cubic.z * spacingY,
    }));
};

// Resolves mounted card indexes by combining hex-ring lookup with pixel-radius filtering.
export const resolveVisibleHexIndexes = (
    center: CubeCoord,
    ringRadius: number,
    coordByKey: Map<string, number>,
    coords: HexGridCoord[],
    worldX: number,
    worldY: number,
    pixelRadius: number
): number[] => {
    const radiusSq = pixelRadius * pixelRadius;
    const indexes: number[] = [];

    forEachCubeInRadius(center, ringRadius, (cube) => {
        const index = coordByKey.get(toCubeKey(cube));
        if (index === undefined) return;

        const coord = coords[index];
        if (!coord) return;

        const dx = coord.baseX - worldX;
        const dy = coord.baseY - worldY;
        if (dx * dx + dy * dy <= radiusSq) {
            indexes.push(index);
        }
    });

    indexes.sort((a, b) => a - b);
    return indexes;
};

export const areIndexListsEqual = (left: readonly number[], right: readonly number[]): boolean => {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
};
