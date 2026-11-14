// src/components/visualizer/machi/gyro.ts
// 町景的陀螺仪适配 —— 实现已搬到 backgrounds/gyroTilt.ts，所有 3D 背景共用。
//
// 这里只保留原来的导出名，免得町景的 engine/camera 等调用点全部改名。
// 新代码请直接从 backgrounds/gyroTilt.ts 引入（或读 stores/useGyroSettingsStore
// 那个全局开关），不要再往这里加东西。

export {
    GYRO_TILT_RANGE as MACHI_GYRO_RANGE,
    GYRO_TILT_MAX_STEP as MACHI_GYRO_MAX_STEP,
    gyroTiltSupported as machiGyroSupported,
    requestGyroTiltPermission as requestMachiGyroPermission,
    gyroScreenAngle as machiScreenAngle,
    gyroScreenOffsets as machiScreenOffsets,
    subscribeGyroTilt as subscribeMachiGyro,
    type GyroTiltOffsets as MachiGyroOffsets,
} from '../backgrounds/gyroTilt';
