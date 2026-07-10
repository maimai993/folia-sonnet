import React from 'react';
import LegacyPlaylistView from '../../PlaylistView';

// @deprecated Kept solely for search-result navigation until the legacy list view is removed.
const PlaylistView: React.FC<React.ComponentProps<typeof LegacyPlaylistView>> = (props) => {
    return <LegacyPlaylistView {...props} />;
};

export default PlaylistView;
