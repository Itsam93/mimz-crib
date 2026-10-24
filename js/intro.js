(() => {
  const intro = document.getElementById("ride-intro");
  const car = document.getElementById("ride-intro-car");

  if (!intro || !car) return;

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const finishIntro = () => {
    intro.classList.remove("is-running");
    intro.classList.add("is-finished");
  };

  if (reducedMotion) {
    finishIntro();
    return;
  }

  const startIntro = () => {
    if (!car.naturalWidth) {
      finishIntro();
      return;
    }

    intro.classList.add("is-running");

    car.addEventListener("animationend", finishIntro, {
      once: true
    });

    window.setTimeout(finishIntro, 2400);
  };

  if (car.complete) {
    startIntro();
  } else {
    car.addEventListener("load", startIntro, { once: true });
    car.addEventListener("error", finishIntro, { once: true });
  }
})();
