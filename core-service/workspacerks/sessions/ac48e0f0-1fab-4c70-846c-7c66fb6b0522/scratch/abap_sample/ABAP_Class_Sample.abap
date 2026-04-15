* ABAP sample class
CLASS lcl_sample DEFINITION.
  PUBLIC SECTION.
    METHODS: constructor IMPORTING iv_title TYPE string,
             get_title RETURNING VALUE(rv_title) TYPE string,
             load_po_from_ekpo IMPORTING iv_po_number TYPE ekpo-ebeln
                               RETURNING VALUE(rt_ekpo) TYPE tt_ekpo.
  PRIVATE SECTION.
    TYPES: tt_ekpo TYPE STANDARD TABLE OF ekpo WITH DEFAULT KEY.
    DATA: mv_title TYPE string.
ENDCLASS.

CLASS lcl_sample IMPLEMENTATION.
  METHOD constructor.
    mv_title = iv_title.
  ENDMETHOD.
  METHOD get_title.
    rv_title = mv_title.
  ENDMETHOD.
  METHOD load_po_from_ekpo.
    " Select PO items from EKPO by PO number
    SELECT * FROM ekpo INTO TABLE rt_ekpo WHERE ebeln = iv_po_number.
  ENDMETHOD.
ENDCLASS.

* Example usage
DATA(lo_book) = NEW lcl_sample( iv_title = 'ABAP Basics' ).
WRITE: / 'Title:', lo_book->get_title( ).

" Demo PO fetch
DATA(lt_ekpo) = lo_book->load_po_from_ekpo( iv_po_number = '4500000000' ).
DATA: ls_ekpo TYPE ekpo.
LOOP AT lt_ekpo INTO ls_ekpo.
  WRITE: / 'Ebeln=', ls_ekpo-ebeln, 'Ebelp=', ls_ekpo-ebelp, 'Matnr=', ls_ekpo-matnr, 'MENGE=', ls_ekpo-menge.
ENDLOOP.
