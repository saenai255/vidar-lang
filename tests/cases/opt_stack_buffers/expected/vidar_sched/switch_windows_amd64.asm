bits 64

extern vidar_go_start
global vidar_switch
global vidar_entry

section .text

;; vidar_switch(save, to), save in rcx and to in rdx: pushes callee-saved registers and the TIB's
;; stack fields, stores rsp in *save, resumes the stack at to. The frame, from the saved rsp:
;; xmm6..xmm15, StackBase, StackLimit, DeallocationStack, r15, r14, r13, r12, rsi, rdi, rbx, rbp,
;; return address (256 bytes, so the saved rsp is 16-byte aligned)
vidar_switch:
	push rbp
	push rbx
	push rdi
	push rsi
	push r12
	push r13
	push r14
	push r15
	push qword [gs:0x1478]
	push qword [gs:0x10]
	push qword [gs:0x08]
	sub rsp, 160
	movaps [rsp], xmm6
	movaps [rsp + 16], xmm7
	movaps [rsp + 32], xmm8
	movaps [rsp + 48], xmm9
	movaps [rsp + 64], xmm10
	movaps [rsp + 80], xmm11
	movaps [rsp + 96], xmm12
	movaps [rsp + 112], xmm13
	movaps [rsp + 128], xmm14
	movaps [rsp + 144], xmm15
	mov [rcx], rsp
	mov rsp, rdx
	movaps xmm6, [rsp]
	movaps xmm7, [rsp + 16]
	movaps xmm8, [rsp + 32]
	movaps xmm9, [rsp + 48]
	movaps xmm10, [rsp + 64]
	movaps xmm11, [rsp + 80]
	movaps xmm12, [rsp + 96]
	movaps xmm13, [rsp + 112]
	movaps xmm14, [rsp + 128]
	movaps xmm15, [rsp + 144]
	add rsp, 160
	pop qword [gs:0x08]
	pop qword [gs:0x10]
	pop qword [gs:0x1478]
	pop r15
	pop r14
	pop r13
	pop r12
	pop rsi
	pop rdi
	pop rbx
	pop rbp
	ret

;; a new goroutine's first resume lands here, with its G in r12 and rsp 16-byte aligned; 32 bytes
;; of shadow space keep it aligned for the call, and the zero above them is its return address
vidar_entry:
	sub rsp, 32
	mov rcx, r12
	call vidar_go_start
	ud2
vidar_entry_end:

section .xdata rdata align=8
entry_unwind:
	db 1, 4, 1, 0	; version 1, no flags; 4-byte prolog; one unwind code; no frame register
	db 4, 0x32	; after 4 bytes: UWOP_ALLOC_SMALL of (3 + 1) * 8 = 32 bytes
	dw 0	; pads the codes to an even count

section .pdata rdata align=4
	dd vidar_entry wrt ..imagebase
	dd vidar_entry_end wrt ..imagebase
	dd entry_unwind wrt ..imagebase
