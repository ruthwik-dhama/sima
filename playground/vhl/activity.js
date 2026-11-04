// Client-rendered three-page activity. Moving between pages re-renders without a document load.
const PAGES = {
  1: { title: 'Lección 3: Completar', directions: 'Completa cada oración con la forma correcta del verbo.', html: `
    <div class="card" data-vhl-item="1"><p>Yo ____ estudiante. (ser)</p><input type="text" name="p1i1" aria-label="Respuesta 1"></div>
    <div class="card" data-vhl-item="2"><p>Mi hermana ____ en Bogotá el año pasado. (vivir)</p><input type="text" name="p1i2" aria-label="Respuesta 2"></div>` },
  2: { title: 'Lección 3: Emparejar', directions: 'Empareja cada palabra con su traducción y elige el artículo.', html: `
    <div class="card" data-vhl-item="1"><p>Empareja las palabras.</p>
      <label>la manzana <select name="m1"><option value="">--</option><option value="apple">apple</option><option value="book">book</option><option value="house">house</option></select></label>
      <label>el libro <select name="m2"><option value="">--</option><option value="apple">apple</option><option value="book">book</option><option value="house">house</option></select></label></div>
    <div class="card" data-vhl-item="2"><p>____ universidad es grande.</p>
      <select name="art" aria-label="Artículo"><option value="">--</option><option value="el">el</option><option value="la">la</option></select></div>` },
  3: { title: 'Lección 3: Escribir', directions: 'Escribe dos oraciones sobre tu familia.', html: `
    <div class="card" data-vhl-item="1"><p>Describe a tu familia en español.</p><textarea name="esc" aria-label="Respuesta escrita"></textarea></div>` },
};
const root = document.getElementById('app');
const key = (name) => `vhl:${name}`;
function render(n) {
  root.dataset.state = 'loading';
  root.innerHTML = '<p>Cargando…</p>';
  setTimeout(() => {
    const page = PAGES[n];
    root.dataset.page = String(n);
    root.innerHTML = `<h1 data-vhl-title>${page.title}</h1><p data-vhl-directions>${page.directions}</p>${page.html}
      <div class="actions"><span>Página ${n} de 3</span>
      ${n < 3 ? '<button type="button" data-vhl-next>Siguiente</button>' : '<button type="button" id="finish">Submit activity</button>'}</div>`;
    root.querySelectorAll('input,select,textarea').forEach((el) => {
      const saved = sessionStorage.getItem(key(el.name));
      if (saved !== null) el.value = saved;
      el.addEventListener('change', () => sessionStorage.setItem(key(el.name), el.value));
    });
    const next = root.querySelector('[data-vhl-next]');
    if (next) next.addEventListener('click', () => {
      history.pushState({}, '', `?page=${n + 1}`);
      render(n + 1);
    });
    root.dataset.state = 'ready';
  }, 300);
}
render(Number(new URLSearchParams(location.search).get('page') ?? 1));
