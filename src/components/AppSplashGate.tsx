import React from 'react';
import SwarmSplashOverlay from './swarmSplash/SwarmSplashOverlay';
import { hideAppSplash } from '../utils/appSplash';
import { readSwarmSplashEnabled } from '../stores/useSwarmSplashStore';
import { useReducedMotionFor } from '../hooks/useReducedMotionFor';

// src/components/AppSplashGate.tsx
// 包在根组件树外层：首帧挂载完成后（useEffect 在浏览器绘制之后触发）移除首屏加载遮罩，
// 保证遮罩淡出时下面已经是渲染好的界面，而不是空白。
//
// 关掉了「群体光标启动动画」或系统要求减少动态效果时，行为与原来一致：只做淡出。
// 开着时先盖一层 canvas 跑建造动画，跑完再摘掉 —— 下面一直是已经渲染好的真实界面，
// 动画画出来的东西不参与布局，所以不会把界面弄变形。

const AppSplashGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const reduceMotion = useReducedMotionFor('transitionOverlay');
    /*
     * 只在挂载那一刻决定放不放：中途改开关不该把正在播的动画掐断，也不该突然补播一个。
     * 系统要求减少动态效果时不播 —— 启动动画是纯装饰，不值得在那种情形下抢首帧。
     */
    const [playing, setPlaying] = React.useState(() => readSwarmSplashEnabled() && !reduceMotion);

    React.useEffect(() => {
        // 不播动画时才需要自己把首屏遮罩淡出；播的话遮罩由覆盖层盖住，等动画结束一起摘。
        if (!playing) hideAppSplash();
    }, [playing]);

    const finish = React.useCallback(() => {
        hideAppSplash();
        setPlaying(false);
    }, []);

    return (
        <>
            {children}
            {playing && <SwarmSplashOverlay onDone={finish} />}
        </>
    );
};

export default AppSplashGate;
