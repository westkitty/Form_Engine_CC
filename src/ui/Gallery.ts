import { fmtBytes, type App } from '../app/App';
import { h, button, dialog, replace, ICON } from './dom';
import * as store from '../persistence/idb';

export async function openGallery(app: App) {
  if (!store.storageAvailable()) return app.toast('warn', 'Local browser storage is unavailable here. Use Save to download a project file.');
  if (app.dirty) await app.autosaveNow();
  const d = dialog('Local projects', { wide: true, id: 'gallery' });
  const grid = h('div', { class: 'gallery' });
  const quota = h('p', { class: 'hint' });
  d.body.append(h('p', { class: 'hint' }, 'Stored in this browser only (IndexedDB). Browser storage can be cleared by the browser or by you — download .formengine files for real backups. Deleting here does not delete anything at any reconstruction provider.'), quota, grid);
  const render = async () => {
    const list = await store.listProjects();
    const est = await store.storageEstimate();
    quota.textContent = est ? `Using ${fmtBytes(est.usage)} of ~${fmtBytes(est.quota)} available to this site.` : '';
    replace(grid, ...list.map((p) => h('article', { class: `card ${p.id === app.projectId ? 'current' : ''}` },
      p.thumbnail ? h('img', { src: p.thumbnail, alt: '' }) : h('div', { class: 'card-ph' }),
      h('div', { class: 'card-meta' }, h('strong', null, p.name), h('span', { class: 'hint' }, `${new Date(p.updatedAt).toLocaleString()} · ${fmtBytes(p.bytes)}`)),
      h('div', { class: 'btn-row' },
        button('Open', async () => { d.close(); await app.openStored(p.id); }, { class: 'tiny', disabled: p.id === app.projectId }),
        button('Duplicate', async () => {
          const r = await store.loadProject(p.id); if (!r) return app.toast('error', 'Could not read project.');
          await app.loadProjectBytes(r.data, { newId: true }); app.projectName = `${p.name} copy`; await app.autosaveNow(); d.close();
        }, { class: 'tiny ghost' }),
        button('Delete', async () => {
          const c = dialog('Delete local project?', { id: 'confirm-del' });
          c.body.append(h('p', null, `This permanently deletes "${p.name}" (both autosave slots, ${fmtBytes(p.bytes)}) from this browser. Downloaded .formengine files and provider-side data are not affected. This cannot be undone.`));
          c.foot.append(button('Keep', () => c.close(), { class: 'ghost' }), button('Delete permanently', async () => {
            await store.deleteProject(p.id); c.close();
            if (p.id === app.projectId) app.toast('info', 'The open project was removed from local storage; it will be saved again as you edit.');
            void render();
          }, { class: 'danger', icon: ICON.trash }));
        }, { class: 'tiny danger' }),
      ))));
    if (!list.length) grid.appendChild(h('p', { class: 'hint' }, 'No local projects yet.'));
  };
  await render();
  d.foot.append(button('New project', () => { d.close(); app.newProject(true); }, { icon: ICON.plus }), button('Close', () => d.close(), { class: 'ghost' }));
}
