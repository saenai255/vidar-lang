	.section __TEXT,__text
	.build_version macos, 10, 0

	.extern _vidar_go_start

	; vidar_switch(save, to): pushes callee-saved registers, stores sp in *save, resumes the stack at to
	.global _vidar_switch
	.align 2
_vidar_switch:
	sub sp, sp, #160
	stp x19, x20, [sp, #0]
	stp x21, x22, [sp, #16]
	stp x23, x24, [sp, #32]
	stp x25, x26, [sp, #48]
	stp x27, x28, [sp, #64]
	stp x29, x30, [sp, #80]
	stp d8,  d9,  [sp, #96]
	stp d10, d11, [sp, #112]
	stp d12, d13, [sp, #128]
	stp d14, d15, [sp, #144]
	mov x2, sp
	str x2, [x0]
	mov sp, x1
	ldp x19, x20, [sp, #0]
	ldp x21, x22, [sp, #16]
	ldp x23, x24, [sp, #32]
	ldp x25, x26, [sp, #48]
	ldp x27, x28, [sp, #64]
	ldp x29, x30, [sp, #80]
	ldp d8,  d9,  [sp, #96]
	ldp d10, d11, [sp, #112]
	ldp d12, d13, [sp, #128]
	ldp d14, d15, [sp, #144]
	add sp, sp, #160
	ret

	; a new goroutine's first resume lands here, with its G in x19
	.global _vidar_entry
	.align 2
_vidar_entry:
	mov x0, x19
	bl _vidar_go_start
	brk #0
