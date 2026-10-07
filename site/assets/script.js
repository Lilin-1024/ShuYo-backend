(() => {
  const links = [...document.querySelectorAll('.toc a')];
  if (!links.length) return;
  const sections = links.map((link) => document.getElementById(link.getAttribute('href').slice(1))).filter(Boolean);
  const update = () => {
    let current = sections[0];
    sections.forEach((section) => { if (section.getBoundingClientRect().top <= 150) current = section; });
    links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${current.id}`));
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
})();
