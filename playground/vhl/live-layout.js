// Reproduces the structure of a live activity, with original questions. Dropdowns mount after load,
// their lists attach to <body>, and only a click on a list item changes the <select>. Setting the
// hidden <select> directly doesn't update the visible button, as on the real site.
document.querySelectorAll('.js-activity-dropdown-wrapper').forEach((wrapper) => {
  const name = wrapper.dataset.name;
  const choices = JSON.parse(wrapper.dataset.listData);
  setTimeout(() => {
    wrapper.innerHTML = `<div class="c-dropdown-disclosure c-activity-dropdown">
      <button type="button" id="${name}_dd_btn" role="combobox" class="c-dropdown-disclosure__button"><span class="disclosure-header-text"></span></button>
      <div class="c-dropdown-disclosure__body" hidden><select id="${name}" name="${name}">${choices.map((c, i) => `<option value="${i === 0 ? '0' : c}">${c}</option>`).join('')}</select></div>
    </div>`;
    const select = wrapper.querySelector('select');
    const button = wrapper.querySelector('button');
    const list = document.createElement('div');
    list.className = 'c-listbox js-listbox';
    list.hidden = true;
    list.innerHTML = `<ul role="listbox">${choices.map((c, i) => `<li class="c-listbox__item" role="option" data-index="${i}" style="cursor:pointer">${c}</li>`).join('')}</ul>`;
    document.body.append(list);
    button.addEventListener('click', () => {
      document.querySelectorAll('.js-listbox').forEach((other) => { if (other !== list) other.hidden = true; });
      list.hidden = !list.hidden;
    });
    list.addEventListener('click', (event) => {
      const item = event.target.closest('[role="option"]');
      if (!item) return;
      select.selectedIndex = Number(item.dataset.index);
      button.querySelector('.disclosure-header-text').textContent = item.textContent;
      list.hidden = true;
    });
  }, 150);
});
document.getElementById('_activity_submit').addEventListener('click', (event) => {
  event.preventDefault();
  document.body.dataset.submitted = 'true';
});
document.getElementById('_activity_save').addEventListener('click', () => {
  document.body.dataset.saved = 'true';
});
