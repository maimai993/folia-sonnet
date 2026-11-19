// src/components/swarmSplash/SwarmSplashOverlay.tsx
// 启动动画的承载层：一块全屏 canvas，上面跑群体光标「建造」动画。
//
// 什么时候结束由自己管（动画跑完调 onDone）；调用方收到 onDone 后把它从树上摘掉，
// 下面就是真实界面 —— 所以动画画出来的东西不参与布局，不可能把界面搞变形。

import React from 'react';
import { createSwarmRuntime } from './swarmRuntime';

type Props = {
    /** 动画结束（含撤离）后调用一次。 */
    onDone: () => void;
    /** 总时长上限（毫秒）：到点无论如何收尾。 */
    maxDurationMs?: number;
};

const SwarmSplashOverlay: React.FC<Props> = ({ onDone, maxDurationMs }) => {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    // onDone 每帧不该变，但父组件重渲染可能换身份：用 ref 接住，避免重启动画。
    const doneRef = React.useRef(onDone);
    doneRef.current = onDone;

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const runtime = createSwarmRuntime({
            canvas,
            maxDurationMs,
            onDone: () => doneRef.current(),
        });
        runtime.start();
        return () => runtime.destroy();
    }, [maxDurationMs]);

    return (
        <div className="fixed inset-0 z-[2147483000]" aria-hidden="true">
            <canvas ref={canvasRef} className="h-full w-full" />
        </div>
    );
};

export default SwarmSplashOverlay;
