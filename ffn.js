async function createFFNPipeline(device) {
  const shader = createFFNShader(device);

  const shaderModule = device.createShaderModule({
    code: shader,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint: "main",
    },
  });

  return pipeline;
}

/*
{
  "n_vocab": 50257,
  "n_ctx": 1024,
  "n_embd": 768,
  "n_head": 12,
  "n_layer": 12
}

*/

const createFFNShader = () => `
    struct Matrix {
        data: array<f32>, // runtime-sized array
    }

    struct Uniforms {
      dimY: u32, // row dimension of A and row dimension of C
      dimX: u32, // col dimension of B and col dimension of C
      dimS: u32, // shared dimension of A and B
    };

    const PI = 3.141592653589793;
    const SQRPI = 0.7978845608;

    fn gelu(x: f32) -> f32 {
      if (x < -10.0) {
        return 0.0;
      } else if (x > 10.0) {
        return x;
      } else {
        let cdf_approx: f32 = 0.5 * (1.0 + tanh(sqrt(2.0 / PI) * (x + 0.044715 * pow(x, 3))));
        return x * cdf_approx;
      }
    }

    fn relu(x: f32) -> f32 {
      return max(0.0, x);
    }

    @group(0) @binding(0) var<storage, read_write> A: Matrix;
    @group(0) @binding(1) var<storage, read_write> B: Matrix;
    @group(0) @binding(2) var<storage, read_write> C: Matrix;
    @group(0) @binding(3) var<uniform> dimBuffer: Uniforms;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
        let row: u32 = global_id.x;
        let col: u32 = global_id.y;
        let dimX: u32 = dimBuffer.dimX;
        let dimY: u32 = dimBuffer.dimY;

        if (row >= dimY || col >= dimX) {
          return;
        }

        let dimS: u32 = dimBuffer.dimS;

        var sum: f32 = 0.0;
        for (var i: u32 = 0; i < dimS; i = i + 1) {
            sum = sum + A.data[row * dimS + i] * B.data[i * dimX + col];
        }

        C.data[row * dimX + col] = sum;
      } 
  `;

async function runFFNDynamic(device, queue, pipeline, A, B, verbose = false) {
  const bindGroupLayout = pipeline.getBindGroupLayout(0);

  const minStorageBufferOffsetAlignment = device.limits.minStorageBufferOffsetAlignment;

  // [row][col]
  const bufferSizeA = alignedSize(A.length * A[0].length * Float32Array.BYTES_PER_ELEMENT, minStorageBufferOffsetAlignment);
  const bufferSizeB = alignedSize(B.length * B[0].length * Float32Array.BYTES_PER_ELEMENT, minStorageBufferOffsetAlignment);
  const bufferSizeC = alignedSize(B[0].length * A.length * Float32Array.BYTES_PER_ELEMENT, minStorageBufferOffsetAlignment);

  // The col dimension of A must match the row dimension of B
  // Or A[0].length === B.length
  if (A[0].length !== B.length) throw new Error("Invalid matrix dimensions");
  const dim = B.length; // or B[0].length
  const masterDimA = A.length;
  const masterDimB = B[0].length;

  const bufferA = device.createBuffer({
    size: bufferSizeA,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const bufferB = device.createBuffer({
    size: bufferSizeB,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const bufferC = device.createBuffer({
    size: bufferSizeC,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const uniformBuffer = device.createBuffer({
    size: 16, // number of bytes, mult of 16
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const flatA = new Float32Array(flatten(A));
  const flatB = new Float32Array(flatten(B));

  queue.writeBuffer(bufferA, 0, flatA);
  queue.writeBuffer(bufferB, 0, flatB);
  queue.writeBuffer(uniformBuffer, 0, new Uint32Array([masterDimA, masterDimB, dim]));

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: bufferA } },
      { binding: 1, resource: { buffer: bufferB } },
      { binding: 2, resource: { buffer: bufferC } },
      { binding: 3, resource: { buffer: uniformBuffer } },
    ],
  });

  const workgroupSizeX = 16;
  const workgroupSizeY = 16;
  const numWorkgroupsX = Math.min(Math.ceil(masterDimA / workgroupSizeX), 256);
  const numWorkgroupsY = Math.min(Math.ceil(masterDimB / workgroupSizeY), 256);

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(pipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(numWorkgroupsX, numWorkgroupsY, 1);
  passEncoder.end();

  const readBuffer = device.createBuffer({
    size: bufferSizeC,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  commandEncoder.copyBufferToBuffer(bufferC, 0, readBuffer, 0, bufferSizeC);

  queue.submit([commandEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = readBuffer.getMappedRange();
  // console.log("arrayBuffer", arrayBuffer);
  const resultArray = new Float32Array(arrayBuffer);

  if (verbose) {
    console.log("A", `(${A.length}x${A[0].length})`, A);
    console.log("B", `(${B.length}x${B[0].length})`, B);
    console.log("C (output)", `(${A.length}x${B[0].length})`);
    console.log("dim or dimS", dim);
    console.log("masterDimA or dimY", masterDimA);
    console.log("masterDimB or dimX", masterDimB);
    console.log("flatA", flatA);
    console.log("flatB", flatB);
    // console.log("arrayBuffer int", new Int32Array(arrayBuffer));
    const resultMatrix = [];
    for (let i = 0; i < A.length; i++) {
      resultMatrix.push(resultArray.slice(i * B[0].length, (i + 1) * B[0].length));
    }
    console.log("resultMatrix", resultMatrix);
  }

  return resultArray;
}
