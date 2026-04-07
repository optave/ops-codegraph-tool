module repository(
    input wire clk,
    input wire reset,
    input wire [7:0] data_in,
    output reg [7:0] store_out
);

    reg [7:0] memory [0:15];
    reg [3:0] write_ptr;

    always @(posedge clk or posedge reset) begin
        if (reset) begin
            write_ptr <= 4'd0;
            store_out <= 8'd0;
        end else begin
            memory[write_ptr] <= data_in;
            store_out <= data_in;
            write_ptr <= write_ptr + 1;
        end
    end

endmodule
