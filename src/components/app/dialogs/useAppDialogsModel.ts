import { useMemo } from 'react';
import { useStatusMessage } from '../../../stores/useStatusMessageStore';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { buildAppDialogsModel, type AppDialogsDeps } from './buildAppDialogsModel';

// src/components/app/dialogs/useAppDialogsModel.ts

/**
 * The dialog model with the three ambient values already filled in.
 *
 * `statusMsg`, `isDaylight` and `currentSong` all live in stores; App.tsx used to read them only so
 * it could hand them straight back here.
 */
export const useAppDialogsModel = (deps: AppDialogsDeps) => {
    const statusMsg = useStatusMessage();
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const currentSong = usePlaybackStore(state => state.currentSong);

    return useMemo(() => buildAppDialogsModel({
        ...deps,
        statusMsg,
        isDaylight,
        currentSong,
        // Spread rather than `deps`: the caller passes an object literal, so depending on the object
        // would rebuild this every render. The key set is fixed by the call site.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [...Object.values(deps), statusMsg, isDaylight, currentSong]);
};
