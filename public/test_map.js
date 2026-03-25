let mapModel;

function preload() {
  console.log("Starting preload...");
  mapModel = loadModel('Img/workshop_map.glb', true, () => {
    console.log("Model loaded successfully!");
  }, (err) => {
    console.error("Error loading model:", err);
  });
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  // Optional: add camera controls
  describe('Test viewing a GLB map');
}

function draw() {
  background(15, 15, 25);
  
  orbitControl(); // allow mouse drag to rotate
  
  ambientLight(150, 150, 150);
  directionalLight(255, 255, 255, 0, 1, -1);
  
  push();
  // Rotate to match typical p5 orientations
  rotateX(PI); // Sometimes models are upside down
  rotateY(frameCount * 0.01);
  scale(1.5);
  noStroke();
  model(mapModel);
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
