module service(
    input wire clk,
    input wire reset,
    input wire valid,
    input wire [7:0] data_in,
    output reg [7:0] result
);

    reg [7:0] store [0:15];
    reg [3:0] count;

    repository repo_inst(
        .clk(clk),
        .reset(reset),
        .data_in(data_in),
        .store_out(store[count])
    );

    always @(posedge clk or posedge reset) begin
        if (reset) begin
            count <= 4'd0;
            result <= 8'd0;
        end else if (valid) begin
            result <= data_in;
            count <= count + 1;
        end
    end

endmodule
