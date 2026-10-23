
(() => {
  const cars = document.querySelectorAll(".section-ride");

  if (!cars.length) return;

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (reducedMotion) {
    cars.forEach((car) => car.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const car = entry.target;

        if (entry.isIntersecting) {
          // Replay the bounce whenever the car re-enters the viewport.
          car.classList.remove("is-visible");
          void car.offsetWidth;
          car.classList.add("is-visible");
        } else {
          // Hide the car when its section leaves the viewport.
          car.classList.remove("is-visible");
        }
      });
    },
    {
      threshold: 0.25,
      rootMargin: "0px 0px -40px 0px",
    }
  );

  cars.forEach((car) => observer.observe(car));
})();
