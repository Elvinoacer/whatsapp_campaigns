// Synthetic directory for a real Chromium execution context. No user data.
export const whatsappFixture = `(() => {
  const wid = id => ({ _serialized: id });
  const contacts = [
    { id: wid('254700000001@c.us'), name: 'Saved contact', isMyContact: true },
    { id: wid('100@lid'), phoneNumber: wid('254700000001@c.us'), pushname: 'Same person' },
    { id: wid('200@lid'), name: 'Private number' },
    { id: wid('254700000002@c.us'), name: 'Broken business getter' }
  ];
  const group = { id: wid('123@g.us'), name: 'Fixture group', groupMetadata: {
    participants: { getModelsArray: () => [
      { id: wid('100@lid') }, { id: wid('200@lid') },
      ...Array.from({ length: window.fixtureExtraGroupMembers || 0 }, (_, i) => ({ id: wid('254709' + String(i).padStart(6, '0') + '@c.us') }))
    ] }
  } };
  window.WWebJS = {};
  window.require = name => {
    if (name === 'WAWebSocketModel') return { Socket: { state: 'CONNECTED' } };
    if (name === 'WAWebCollections') return {
      Contact: { getModelsArray: () => contacts }, Chat: { getModelsArray: () => [group] },
      GroupMetadata: { update: async () => { if (window.fixtureFailMetadata) throw new Error('Metadata unavailable'); } }
    };
    if (name === 'WAWebFrontendContactGetters') return { getIsMyContact: contact => {
      if (contact.name === 'Broken business getter') throw new Error('r');
      return contact.isMyContact === true;
    } };
    if (name === 'WAWebLidMigrationUtils') return { toPn: () => undefined };
    throw new Error('Unexpected module ' + name);
  };
})()`;
